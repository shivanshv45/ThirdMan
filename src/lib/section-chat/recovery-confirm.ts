import { loadDemoFailureBatch } from "@/lib/recovery/demo-batch";
import { runRecoveryBatch } from "@/lib/recovery/sequencer";
import { recoveryProposalSchema, type RecoveryProposal } from "./recovery-schema";

/**
 * The Recovery section chat bar's write-facing half. Calls the exact
 * same functions actions.ts's loadDemoBatchAction and
 * runRecoveryBatchAction call — never a parallel path. No import of
 * recovery-draft.ts or the LLM wrapper, checked by
 * section-chat/recovery.isolation.test.ts.
 */

export async function confirmRecoveryAction(
  merchantId: string,
  proposal: RecoveryProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = recoveryProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "load_demo_batch") {
      await loadDemoFailureBatch(merchantId);
      return { ok: true };
    }

    if (parsed.data.kind === "run_recovery_batch") {
      await runRecoveryBatch(merchantId);
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not run that action." };
  }
}
