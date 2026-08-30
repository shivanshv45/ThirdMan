import { ProjectScope } from "../fs-scope.js";
import { detectStack } from "../stacks/detect.js";
import { runAudit } from "../audit.js";
import { renderReport, renderBeforeAfter } from "../report.js";
import { planWrite, applyWrite } from "../generate/diff.js";
import { generateDiscoveryDoc } from "../generate/discovery-doc.js";
import { generateConfig } from "../generate/config.js";
import { snippetTargetForStack, generateSnippetWrite } from "../generate/snippet.js";
import { envLocalIsGitignored, writeAgentKeyToEnvLocal, UnsafeSecretWriteError } from "../secrets.js";
import { redeemLinkToken } from "../link.js";
import { realPrompter, type Prompter } from "../prompter.js";
import type { FileWrite } from "../generate/diff.js";
import type { AuditReport } from "../types.js";

export interface InitOptions {
  root: string;
  dryRun: boolean;
  appOrigin: string;
  prompter?: Prompter;
  log?: (line: string) => void;
}

export interface InitResult {
  before: AuditReport;
  after: AuditReport | null;
  written: string[];
  skipped: string[];
}

/**
 * L20-1/L20-5/L20-7's `thirdman init`: detect → audit → show diffs for
 * every write, one at a time, confirmed separately → offer account
 * linking → re-audit → honest before/after. Every write this function
 * makes is the merchant's own explicit "yes" on that exact diff — see
 * plans/layer-20-merchant-cli.md's governing rule. --dry-run runs the
 * exact same flow but every confirmation prompt is skipped and nothing
 * is written, so the fixture directory is byte-identical afterward.
 *
 * `prompter`/`log` are injectable so tests exercise this exact function
 * without a real TTY (prompts' real backend reads raw keypresses, which
 * piped/CI input can't drive reliably) — see prompter.ts and L20-8.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const prompter = opts.prompter ?? realPrompter;
  const log = opts.log ?? ((line: string) => console.log(line));
  const scope = new ProjectScope(opts.root);

  log(`\nthirdman — auditing ${scope.root}\n`);

  const detection = detectStack(scope);
  if (detection.ambiguousWith && detection.ambiguousWith.length > 0) {
    log(`Stack detection is ambiguous: found evidence for both "${detection.stack}" and "${detection.ambiguousWith.join(", ")}".`);
    const chosen = await prompter.select("Which stack should generated files target?", [detection.stack, ...detection.ambiguousWith]);
    if (chosen) detection.stack = chosen;
  } else {
    log(`Detected stack: ${detection.stack} (${detection.evidence.join("; ")})`);
  }

  const before = runAudit(scope);
  log(`\n${renderReport(before, "Readiness before")}\n`);

  if (opts.dryRun) {
    log("--dry-run: no files will be written. Stopping after the audit.");
    return { before, after: null, written: [], skipped: [] };
  }

  const proceed = await prompter.confirm("Generate the discovery document and config now?", true);
  if (!proceed) {
    log("Nothing written.");
    return { before, after: null, written: [], skipped: [] };
  }

  let merchantId: string | null = null;
  let merchantName = "your store";
  const publishableKey = "REPLACE_WITH_YOUR_EMBED_PUBLISHABLE_KEY";
  let origin = "https://your-site.example.com";
  let agentKey: string | null = null;

  const wantsLink = await prompter.confirm("Link a Thirdman merchant account now? (generates a token on /dashboard/cli)", false);
  if (wantsLink) {
    const token = await prompter.text("Paste the token from /dashboard/cli:");
    const agentName = await prompter.text("Name for the new agent key:", "CLI agent");
    const detectedOrigin = await prompter.text("Origin to allowlist (leave blank to skip):", "");

    if (token) {
      const linkResult = await redeemLinkToken(opts.appOrigin, token, agentName || "CLI agent", detectedOrigin || null);
      if (linkResult.ok) {
        merchantId = linkResult.result.merchantId;
        merchantName = linkResult.result.merchantName;
        agentKey = linkResult.result.apiKey;
        if (detectedOrigin) origin = detectedOrigin;
        log(`Linked to "${merchantName}". Agent "${linkResult.result.agentName}" created.`);
      } else {
        log(`Could not link: ${linkResult.error}`);
      }
    }
  }

  const writes: FileWrite[] = [
    generateDiscoveryDoc({ merchantId, merchantName, origin, appOrigin: opts.appOrigin }),
    generateConfig({ merchantId: merchantId ?? "unlinked", publishableKey, allowedOrigin: origin, appOrigin: opts.appOrigin }),
  ];

  const snippetTarget = snippetTargetForStack(detection.stack);
  if (snippetTarget) {
    const existing = scope.exists(snippetTarget.relativePath) ? scope.readFile(snippetTarget.relativePath) : "";
    writes.push(generateSnippetWrite(snippetTarget, existing, opts.appOrigin, publishableKey));
  } else {
    log(`No automatic snippet injection for stack "${detection.stack}" yet — here's the manual snippet to paste yourself:`);
    log(`  <script async src="${opts.appOrigin}/api/embed/v1.js" data-embed-key="${publishableKey}"></script>`);
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const write of writes) {
    const planned = planWrite(scope, write);
    if (planned.unchanged) {
      log(`\n${planned.relativePath}: already up to date, nothing to write.`);
      continue;
    }

    log(`\n--- diff: ${planned.relativePath} ---`);
    log(planned.diff);
    const confirmWrite = await prompter.confirm(`Write ${planned.relativePath}?`, true);
    if (confirmWrite) {
      applyWrite(scope, write);
      written.push(planned.relativePath);
      log(`Wrote ${planned.relativePath}.`);
    } else {
      skipped.push(planned.relativePath);
      log(`Skipped ${planned.relativePath}.`);
    }
  }

  if (agentKey) {
    try {
      if (!envLocalIsGitignored(scope)) {
        log(`\nRefusing to write the agent key to .env.local: it is not covered by .gitignore. Add ".env.local" to .gitignore and re-run to store it — the key is NOT written anywhere.`);
        log(`Your agent key (store it somewhere safe now): ${agentKey}`);
      } else {
        const confirmSecret = await prompter.confirm("Write the new agent key to .env.local (gitignored)?", true);
        if (confirmSecret) {
          writeAgentKeyToEnvLocal(scope, "THIRDMAN_AGENT_API_KEY", agentKey);
          log("Wrote THIRDMAN_AGENT_API_KEY to .env.local.");
        } else {
          log(`Not written. Your agent key (store it somewhere safe now): ${agentKey}`);
        }
      }
    } catch (err) {
      if (err instanceof UnsafeSecretWriteError) {
        log(`\n${err.message}`);
        log(`Your agent key (store it somewhere safe now): ${agentKey}`);
      } else {
        throw err;
      }
    }
  }

  const after = runAudit(scope);
  log(`\n${renderBeforeAfter(before, after)}\n`);

  return { before, after, written, skipped };
}
