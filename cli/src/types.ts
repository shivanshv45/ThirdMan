/**
 * Mirrors agent-readiness.ts's ReadinessCheck/ReadinessReport shape
 * deliberately (see plans/layer-20-merchant-cli.md's L20-3: "keep the
 * shape identical... so the two reports read as one product"). This
 * module runs against a filesystem, not database rows — the inputs have
 * nothing in common, so it is NOT shared code, only a shared interface.
 * See DECISIONS.md for why the duplication is deliberate.
 */

export interface AuditCheck {
  id: string;
  label: string;
  weight: number;
  passed: boolean;
  /** Present only when the check failed. A finding a merchant can't act on is noise, so a real file/line is included whenever one exists. */
  fix?: { message: string; file?: string; line?: number };
}

export interface AuditReport {
  score: number;
  checks: AuditCheck[];
}

export function computeScore(checks: AuditCheck[]): number {
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = checks.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
  return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
}

export function buildReport(checks: AuditCheck[]): AuditReport {
  return { score: computeScore(checks), checks };
}

export type StackKind = "nextjs" | "remix" | "astro" | "express" | "hydrogen" | "woocommerce" | "static_html" | "unknown";

export interface DetectionResult {
  stack: StackKind;
  /** Real files that led to this conclusion — every detection is evidence-based, never a directory-name guess. */
  evidence: string[];
  /** Set only when two or more stacks matched with real evidence — L20-2's "say so and ask" case, never resolved by a coin flip. */
  ambiguousWith?: StackKind[];
}
