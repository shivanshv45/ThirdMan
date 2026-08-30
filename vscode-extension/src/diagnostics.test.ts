import { describe, it, expect } from "vitest";
import { placeDiagnostics } from "./diagnostics.js";
import type { AuditCheck } from "../../cli/src/types.js";

describe("placeDiagnostics", () => {
  it("skips passed checks entirely", () => {
    const checks: AuditCheck[] = [{ id: "a", label: "A", weight: 10, passed: true }];
    expect(placeDiagnostics(checks)).toEqual([]);
  });

  it("skips a failed check with no fix (nothing actionable to show)", () => {
    const checks: AuditCheck[] = [{ id: "a", label: "A", weight: 10, passed: false }];
    expect(placeDiagnostics(checks)).toEqual([]);
  });

  it("converts a fix's 1-indexed line to a 0-indexed line for vscode.Range", () => {
    const checks: AuditCheck[] = [
      { id: "robots_does_not_block_agents", label: "robots", weight: 15, passed: false, fix: { message: "blocked", file: "robots.txt", line: 2 } },
    ];
    const placed = placeDiagnostics(checks);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ relativePath: "robots.txt", line: 1, checkId: "robots_does_not_block_agents", severity: "warning" });
    expect(placed[0].message).toContain("blocked");
  });

  it("defaults to line 0 (the file's first line) when a fix has a file but no line", () => {
    const checks: AuditCheck[] = [{ id: "x", label: "X", weight: 10, passed: false, fix: { message: "m", file: "a.txt" } }];
    expect(placeDiagnostics(checks)[0].line).toBe(0);
  });

  it("routes a fileless finding to the package.json fallback location, as an information-severity diagnostic", () => {
    const checks: AuditCheck[] = [{ id: "catalogue_locatable", label: "Catalogue", weight: 25, passed: false, fix: { message: "none found" } }];
    const placed = placeDiagnostics(checks);
    expect(placed[0]).toMatchObject({ relativePath: "package.json", line: 0, severity: "information" });
  });

  it("groups multiple findings for the same file together (both entries present, not overwritten)", () => {
    const checks: AuditCheck[] = [
      { id: "a", label: "A", weight: 10, passed: false, fix: { message: "m1", file: "x.txt", line: 1 } },
      { id: "b", label: "B", weight: 10, passed: false, fix: { message: "m2", file: "x.txt", line: 5 } },
    ];
    const placed = placeDiagnostics(checks);
    expect(placed).toHaveLength(2);
    expect(placed.every((p) => p.relativePath === "x.txt")).toBe(true);
    expect(placed.map((p) => p.line)).toEqual([0, 4]);
  });
});
