import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { getMerchantPolicy } from "@/lib/dashboard";
import { policiesProposalSchema, POLICIES_SCHEMA_DESCRIPTION, type PoliciesProposal } from "./policies-schema";

/**
 * The Policies section chat bar's model-facing half. No import of
 * policies-confirm.ts — see section-chat/policies.isolation.test.ts.
 * setMerchantPolicy is a full replace, so the current row is read here
 * and given to the model as context, otherwise a one-field instruction
 * like "extend the return window" would silently null out everything
 * else.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: PoliciesProposal;
  question?: string;
  reason?: string;
}

export async function draftPoliciesAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want, e.g. "accept returns for 30 days, refund to original payment method".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the form below instead." };
  }

  const current = await getMerchantPolicy(merchantId);
  const transcript = history.map((t) => `${t.role === "merchant" ? "Merchant" : "You"}: ${t.text}`).join("\n");

  try {
    const { data } = await completeStructured({
      prompt: `You manage return/refund/shipping policy on a merchant dashboard's Policies section, talking with a merchant who may be vague and expects you to ask for whatever specific detail is missing. The merchant's current policy is: ${JSON.stringify(current)}\n\nConversation so far:\n${transcript}\n\nProduce the merchant's full new policy: carry over every field from the current policy the conversation didn't mention, and change only what was asked for. If there is no current policy and the conversation doesn't give enough to set a sane one, ask one clarifying question.`,
      schema: policiesProposalSchema,
      schemaDescription: POLICIES_SCHEMA_DESCRIPTION,
    });

    const parsed = policiesProposalSchema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, reason: `Could not draft a valid action: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }

    if (parsed.data.kind === "clarify") {
      return { ok: false, question: parsed.data.question };
    }

    if (parsed.data.kind === "no_action") {
      return { ok: false, reason: parsed.data.summary };
    }

    return { ok: true, proposal: parsed.data };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "The model is unavailable right now. Use the form below instead." };
  }
}
