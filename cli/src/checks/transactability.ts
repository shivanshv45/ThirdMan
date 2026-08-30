import { ProjectScope } from "../fs-scope.js";
import type { AuditCheck } from "../types.js";
import { checkoutRequiresHumanOnlyStep } from "../../../shared/store-readiness-checks.js";
import { findLineNumber } from "../../../shared/find-line.js";

const HUMAN_ONLY_LINE_PATTERN = /captcha|recaptcha|hcaptcha|\botp\b|one-time.?password/i;

/**
 * L20-3: does checkout require a step only a human can complete, and
 * does any real API surface exist at all (a render-only site has
 * nothing for an agent to call).
 *
 * The human-only-step predicate comes from shared/store-readiness-checks.ts,
 * the same file the Instant Audit's store-checks.ts imports (L24-11).
 */

export function checkTransactability(scope: ProjectScope, allFiles: string[]): AuditCheck[] {
  const checks: AuditCheck[] = [];

  const checkoutFiles = allFiles.filter((f) => /checkout|cart/i.test(f) && (f.endsWith(".tsx") || f.endsWith(".jsx") || f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".php") || f.endsWith(".html")));

  let humanOnlyFile: string | undefined;
  let humanOnlyLine: number | undefined;
  for (const f of checkoutFiles) {
    const content = safeRead(scope, f);
    if (content && checkoutRequiresHumanOnlyStep(content)) {
      humanOnlyFile = f;
      humanOnlyLine = findLineNumber(content, HUMAN_ONLY_LINE_PATTERN) ?? undefined;
      break;
    }
  }
  checks.push({
    id: "no_human_only_checkout_gate",
    label: "Checkout does not require a CAPTCHA or OTP step before price is visible",
    weight: 20,
    passed: humanOnlyFile === undefined,
    fix: humanOnlyFile
      ? { message: `${humanOnlyFile} appears to reference a CAPTCHA or OTP step in checkout — an AI buyer cannot complete this without a human present.`, file: humanOnlyFile, line: humanOnlyLine }
      : undefined,
  });

  const apiDirs = allFiles.filter((f) => /(^|\/)api\//i.test(f) || /(^|\/)routes\//i.test(f) || f.includes("wp-json"));
  checks.push({
    id: "api_surface_exists",
    label: "An existing API surface was found (not render-only)",
    weight: 15,
    passed: apiDirs.length > 0,
    fix:
      apiDirs.length === 0
        ? { message: "No API route directory was found — a render-only site gives an agent nothing to call beyond scraping rendered HTML. The embed widget `thirdman init` can generate gives you one without building your own." }
        : undefined,
  });

  return checks;
}

function safeRead(scope: ProjectScope, relativePath: string): string | null {
  try {
    return scope.readFile(relativePath);
  } catch {
    return null;
  }
}
