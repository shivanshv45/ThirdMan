/** Plain-text rendering of an AuditReport — used by every command that prints one. */
export function renderReport(report, title) {
    const lines = [];
    lines.push(`${title}: ${report.score}/100`);
    for (const check of report.checks) {
        const mark = check.passed ? "✓" : "✗";
        lines.push(`  ${mark} [${check.weight}] ${check.label}`);
        if (!check.passed && check.fix) {
            lines.push(`      fix: ${check.fix.message}`);
            if (check.fix.file)
                lines.push(`      at: ${check.fix.file}${check.fix.line ? `:${check.fix.line}` : ""}`);
        }
    }
    return lines.join("\n");
}
/**
 * L20-7: the tool's closing output — before/after score, delta, and
 * what remains unfixed and why. Must stay honest: a check the tool
 * couldn't fix is reported as still failing, never silently dropped.
 */
export function renderBeforeAfter(before, after) {
    const lines = [];
    const delta = after.score - before.score;
    lines.push(`Readiness: ${before.score} → ${after.score} (${delta >= 0 ? "+" : ""}${delta})`);
    const stillFailing = after.checks.filter((c) => !c.passed);
    if (stillFailing.length === 0) {
        lines.push("Every check passes.");
    }
    else {
        lines.push(`${stillFailing.length} check(s) still failing:`);
        for (const c of stillFailing) {
            lines.push(`  ✗ ${c.label}${c.fix ? ` — ${c.fix.message}` : ""}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=report.js.map