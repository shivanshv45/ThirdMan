import type { AuditCheck } from "../../cli/src/types.js";

/**
 * Pure mapping from an AuditCheck to where it belongs in the Problems
 * panel — deliberately factored out of extension.ts so it's testable
 * without launching a real vscode Extension Host (that module isn't
 * importable outside one). Returns 0-indexed line/column, matching
 * vscode.Range's own convention, so extension.ts only has to wrap this
 * in vscode.Diagnostic/vscode.Range without re-deriving any of the logic.
 */

export interface PlacedDiagnostic {
  relativePath: string;
  line: number; // 0-indexed
  message: string;
  checkId: string;
  severity: "warning" | "information";
}

const FILELESS_FALLBACK_PATH = "package.json";

export function placeDiagnostics(checks: AuditCheck[]): PlacedDiagnostic[] {
  const placed: PlacedDiagnostic[] = [];

  for (const check of checks) {
    if (check.passed || !check.fix) continue;

    if (check.fix.file) {
      placed.push({
        relativePath: check.fix.file,
        line: Math.max(0, (check.fix.line ?? 1) - 1),
        message: `[${check.label}] ${check.fix.message}`,
        checkId: check.id,
        severity: "warning",
      });
    } else {
      // No file at all — a workspace-level finding (e.g. "no catalogue
      // file found anywhere"). Anchored to a real, almost-always-present
      // file rather than fabricating a location; see extension.ts's
      // publishDiagnostics for what happens when even that is absent.
      placed.push({
        relativePath: FILELESS_FALLBACK_PATH,
        line: 0,
        message: `[${check.label}] ${check.fix.message}`,
        checkId: check.id,
        severity: "information",
      });
    }
  }

  return placed;
}
