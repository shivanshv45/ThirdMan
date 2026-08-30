import { ProjectScope } from "../fs-scope.js";
import type { AuditCheck } from "../types.js";
import { SNIPPET_MARKER_START } from "../generate/snippet.js";

/**
 * L20-3/L20-8's "integration state" checks — is the embed already
 * wired up. Re-checked by both `init` (before/after) and `doctor`
 * (which re-verifies a previously-completed integration still works).
 */

export function checkIntegrationState(scope: ProjectScope, allFiles: string[]): AuditCheck[] {
  const checks: AuditCheck[] = [];

  const injectedFile = allFiles.find((f) => {
    const content = safeRead(scope, f);
    return content !== null && content.includes(SNIPPET_MARKER_START);
  });

  checks.push({
    id: "script_tag_present",
    label: "The embed script tag is present",
    weight: 15,
    passed: injectedFile !== undefined,
    fix: injectedFile ? undefined : { message: "The thirdman embed snippet was not found in any file. Run `thirdman init` and confirm the snippet-injection step." },
  });

  const configFile = allFiles.find((f) => f === "thirdman.config.json" || f === "thirdman.config.ts");
  let allowlistLooksConfigured = false;
  if (configFile) {
    const content = safeRead(scope, configFile);
    allowlistLooksConfigured = content !== null && content.includes("origin");
  }
  checks.push({
    id: "config_present",
    label: "thirdman.config exists with an allowlisted origin",
    weight: 10,
    passed: configFile !== undefined && allowlistLooksConfigured,
    fix:
      !configFile
        ? { message: "No thirdman.config.json/.ts found. Run `thirdman init` to generate one." }
        : !allowlistLooksConfigured
          ? { message: `${configFile} exists but doesn't record an origin — check it manually against /dashboard/embed's allowlist.`, file: configFile }
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
