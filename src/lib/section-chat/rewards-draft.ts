import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { TIER_PRESETS } from "@/app/dashboard/rewards/tier-presets";
import { rewardsProposalSchema, REWARDS_SCHEMA_DESCRIPTION, type RewardsProposal } from "./rewards-schema";

/**
 * The Rewards section chat bar's model-facing half. A merchant types
 * what they want in plain English; the model maps it onto the closed
 * set of real actions rewards-confirm.ts can perform. This file has NO
 * import of rewards-confirm.ts, the only module that ever writes a row
 * (see section-chat.isolation.test.ts) — same structural proof as
 * setup-conversation, memory, and returns before it.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: RewardsProposal;
  question?: string;
  reason?: string;
}

export async function draftRewardsAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want to change, e.g. "make coins worth 2 rupees each".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the form below instead." };
  }

  const availableModels = TIER_PRESETS.map((p) => `${p.modelId} (${p.displayName})`).join(", ");
  const transcript = history.map((t) => `${t.role === "merchant" ? "Merchant" : "You"}: ${t.text}`).join("\n");

  try {
    const { data } = await completeStructured({
      prompt: `You manage the reward-coin program on a merchant dashboard's Rewards section, talking with a merchant who may be vague and expects you to ask for whatever specific detail is missing. The merchant's real available AI credit tier models are: ${availableModels}.\n\nConversation so far:\n${transcript}\n\nMap it onto exactly one real action, or ask one clarifying question if something required is missing.`,
      schema: rewardsProposalSchema,
      schemaDescription: REWARDS_SCHEMA_DESCRIPTION,
    });

    const parsed = rewardsProposalSchema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, reason: `Could not draft a valid change: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }

    if (parsed.data.kind === "clarify") {
      return { ok: false, question: parsed.data.question };
    }

    if (parsed.data.kind === "no_action") {
      return { ok: false, reason: parsed.data.summary };
    }

    if (parsed.data.kind === "add_ai_credit_tier") {
      const modelId = parsed.data.modelId;
      if (!TIER_PRESETS.some((p) => p.modelId === modelId)) {
        return { ok: false, reason: `"${modelId}" is not one of this merchant's real available models.` };
      }
    }

    return { ok: true, proposal: parsed.data };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "The model is unavailable right now. Try the form below instead." };
  }
}
