/**
 * Mirrors agent-readiness.ts's ReadinessCheck/ReadinessReport shape
 * deliberately (see plans/layer-20-merchant-cli.md's L20-3: "keep the
 * shape identical... so the two reports read as one product"). This
 * module runs against a filesystem, not database rows — the inputs have
 * nothing in common, so it is NOT shared code, only a shared interface.
 * See DECISIONS.md for why the duplication is deliberate.
 */
export function computeScore(checks) {
    const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
    const earnedWeight = checks.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
    return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
}
export function buildReport(checks) {
    return { score: computeScore(checks), checks };
}
//# sourceMappingURL=types.js.map