import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runAuditCommand } from "./commands/audit.js";
import { runDoctorCommand } from "./commands/doctor.js";

const DEFAULT_APP_ORIGIN = process.env.THIRDMAN_APP_ORIGIN ?? "http://localhost:3000";

const program = new Command();

program
  .name("thirdman")
  .description("A merchant's own codebase auditor for AI-buyer readiness. See https://github.com — /dashboard/cli.")
  .version("0.1.0");

program
  .command("init")
  .description("Detect your stack, audit your repo, and offer to write the integration as a diff you approve.")
  .option("--root <path>", "project root to operate on", process.cwd())
  .option("--dry-run", "audit only, write nothing", false)
  .option("--app-origin <url>", "the Thirdman deployment to link against", DEFAULT_APP_ORIGIN)
  .action(async (options: { root: string; dryRun: boolean; appOrigin: string }) => {
    await runInit({ root: options.root, dryRun: options.dryRun, appOrigin: options.appOrigin });
  });

program
  .command("audit")
  .description("Read-only: detect and report, write nothing. Exits non-zero below --threshold, for CI.")
  .option("--root <path>", "project root to operate on", process.cwd())
  .option("--threshold <n>", "minimum score to exit 0", (v) => Number(v), 0)
  .action(async (options: { root: string; threshold: number }) => {
    const code = await runAuditCommand({ root: options.root, threshold: options.threshold });
    process.exitCode = code;
  });

program
  .command("doctor")
  .description("Verify an existing integration still works: script tag, allowlist, discovery document, agent key.")
  .option("--root <path>", "project root to operate on", process.cwd())
  .option("--app-origin <url>", "the Thirdman deployment to check against", DEFAULT_APP_ORIGIN)
  .option("--merchant-id <id>", "merchant id, for the per-merchant manifest check")
  .option("--api-key <key>", "an agent API key, to verify it still authenticates")
  .action(async (options: { root: string; appOrigin: string; merchantId?: string; apiKey?: string }) => {
    const code = await runDoctorCommand({ root: options.root, appOrigin: options.appOrigin, merchantId: options.merchantId, apiKey: options.apiKey });
    process.exitCode = code;
  });

program.parseAsync(process.argv);
