import { ProjectScope } from "./fs-scope.js";
import { buildReport } from "./types.js";
import type { AuditReport } from "./types.js";
import { checkDiscoverability } from "./checks/discoverability.js";
import { checkMachineReadability } from "./checks/machine-readable.js";
import { checkTransactability } from "./checks/transactability.js";
import { checkIntegrationState } from "./checks/integration.js";

/**
 * L20-3: the full audit — every named, weighted check, run against a
 * real listing of the project's own files. No model call happens here;
 * a model's only legitimate job (summarizing findings in prose) lives
 * in summarize.ts, called separately by the caller after this returns.
 */
export function runAudit(scope: ProjectScope): AuditReport {
  const allFiles = scope.listFiles(".");

  const checks = [
    ...checkDiscoverability(scope, allFiles),
    ...checkMachineReadability(scope, allFiles),
    ...checkTransactability(scope, allFiles),
    ...checkIntegrationState(scope, allFiles),
  ];

  return buildReport(checks);
}
