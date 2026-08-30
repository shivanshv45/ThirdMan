import type { AuditReport } from "./types.js";

/**
 * L20-3's "the model's one legitimate job in the audit": turning
 * structured findings into a short plain-English summary. NOT built
 * this session — there is no CLI-facing model-proxy endpoint on the
 * main app yet, and calling a provider directly from the CLI with a
 * merchant's own key is real scope this session didn't reach. Recorded
 * as a deliberate, named gap (see PROGRESS.md/DECISIONS.md), not a
 * silent omission: this function is the seam where that call belongs,
 * and it already implements the required degrade-to-no-prose behavior,
 * so nothing downstream needs to change when it's wired up.
 */
export async function summarizeFindings(_report: AuditReport): Promise<string | null> {
  return null;
}
