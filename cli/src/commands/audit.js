import { ProjectScope } from "../fs-scope.js";
import { detectStack } from "../stacks/detect.js";
import { runAudit } from "../audit.js";
import { renderReport } from "../report.js";
/** `thirdman audit`: read-only, writes nothing, exits non-zero below the threshold so it can sit in CI (L20-1). */
export async function runAuditCommand(opts) {
    const scope = new ProjectScope(opts.root);
    const detection = detectStack(scope);
    console.log(`Detected stack: ${detection.stack}${detection.ambiguousWith ? ` (ambiguous with ${detection.ambiguousWith.join(", ")})` : ""}`);
    const report = runAudit(scope);
    console.log(`\n${renderReport(report, "Readiness")}\n`);
    if (report.score < opts.threshold) {
        console.log(`Score ${report.score} is below threshold ${opts.threshold}.`);
        return 1;
    }
    return 0;
}
//# sourceMappingURL=audit.js.map