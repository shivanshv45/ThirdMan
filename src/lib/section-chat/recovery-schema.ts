import { z } from "zod";

/**
 * The closed shape a Recovery section-chat proposal must match. Unlike
 * Rewards, this section has no editable settings, only two whole-queue
 * batch actions (actions.ts's loadDemoBatchAction and
 * runRecoveryBatchAction) — picking one specific failure out of a
 * queue by free-text description is exactly the kind of low-value,
 * error-prone judgment call that stays a manual click in the existing
 * table instead of a chat command.
 */

const loadDemoBatchProposal = z.object({
  kind: z.literal("load_demo_batch"),
  summary: z.string().trim().min(1).max(240),
});

const runRecoveryBatchProposal = z.object({
  kind: z.literal("run_recovery_batch"),
  summary: z.string().trim().min(1).max(240),
});

const noActionProposal = z.object({
  kind: z.literal("no_action"),
  summary: z.string().trim().min(1).max(240),
});

export const recoveryProposalSchema = z.discriminatedUnion("kind", [
  loadDemoBatchProposal,
  runRecoveryBatchProposal,
  noActionProposal,
]);

export type RecoveryProposal = z.infer<typeof recoveryProposalSchema>;

export const RECOVERY_SCHEMA_DESCRIPTION = `{"kind": "load_demo_batch" | "run_recovery_batch" | "no_action", "summary": one sentence}. Use "load_demo_batch" when the merchant wants to load a batch of labelled-simulated failed payments to see the pipeline work (e.g. "load some test failures", "give me a demo batch"). Use "run_recovery_batch" when the merchant wants the pipeline to actually run its bounded recovery attempts against everything currently pending (e.g. "run recovery", "try to recover what's outstanding", "process the queue"). If the instruction does not clearly ask for one of these two real actions, return "no_action" with a summary explaining why.`;
