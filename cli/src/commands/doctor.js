import { ProjectScope } from "../fs-scope.js";
import { runDoctor } from "../doctor.js";
import { renderReport } from "../report.js";
import { buildReport } from "../types.js";
/** `thirdman doctor`: verify a previously-completed integration still works, including two real network checks (L20-1). */
export async function runDoctorCommand(opts) {
    const scope = new ProjectScope(opts.root);
    const checks = await runDoctor(scope, { appOrigin: opts.appOrigin, merchantId: opts.merchantId, apiKey: opts.apiKey });
    const report = buildReport(checks);
    console.log(`\n${renderReport(report, "Integration health")}\n`);
    return report.checks.every((c) => c.passed) ? 0 : 1;
}
//# sourceMappingURL=doctor.js.map