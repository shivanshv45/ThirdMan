import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { recoveryProposalSchema, RECOVERY_SCHEMA_DESCRIPTION, type RecoveryProposal } from "./recovery-schema";

/**
 * The Recovery section chat bar's model-facing half. No import of
 * recovery-confirm.ts, the only module that ever calls a batch
 * function — see section-chat/recovery.isolation.test.ts.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: RecoveryProposal;
  question?: string;
  reason?: string;
}

export async function draftRecoveryAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want, e.g. "run recovery on everything pending".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the buttons below instead." };
  }

  try {
    const { data } = await completeStructured({
      prompt: `You manage the revenue recovery pipeline on a merchant dashboard's Recovery section. A merchant typed this instruction: "${latest.text}"\n\nMap the instruction onto exactly one real action, or say it doesn't match either.`,
      schema: recoveryProposalSchema,
      schemaDescription: RECOVERY_SCHEMA_DESCRIPTION,
    });

    const parsed = recoveryProposalSchema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, reason: `Could not draft a valid action: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }

    if (parsed.data.kind === "no_action") {
      return { ok: false, reason: parsed.data.summary };
    }

    return { ok: true, proposal: parsed.data };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "The model is unavailable right now. Use the buttons below instead." };
  }
}
