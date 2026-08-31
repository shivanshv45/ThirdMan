import * as mutations from "@/lib/dashboard-mutations";
import { TIER_PRESETS } from "@/app/dashboard/rewards/tier-presets";
import { rewardsProposalSchema, type RewardsProposal } from "./rewards-schema";

/**
 * The Rewards section chat bar's write-facing half. Calls the exact
 * same mutation functions actions.ts's manual forms call — never a
 * parallel write path — so a chat-drafted change is bounded, validated,
 * and audited identically to a merchant filling in the form by hand.
 * This file has NO import of rewards-draft.ts or of the LLM wrapper,
 * checked by section-chat.isolation.test.ts: a confirm can never
 * itself consult a model, only execute what a human already approved.
 */

export async function confirmRewardsAction(
  merchantId: string,
  proposal: RewardsProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Re-validated against the same closed schema the draft was checked
  // against — a proposal is untrusted input the instant it crosses back
  // from the client, exactly like any other form submission.
  const parsed = rewardsProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "set_reward_settings") {
      await mutations.setRewardSettings({
        merchantId,
        paisePerCoinRupees: parsed.data.paisePerCoinRupees,
        issueRatePermille: parsed.data.issueRatePermille,
        maxRedemptionPercent: parsed.data.maxRedemptionPercent,
      });
      return { ok: true };
    }

    if (parsed.data.kind === "add_ai_credit_tier") {
      const { modelId, coinsPerRequest } = parsed.data;
      const preset = TIER_PRESETS.find((p) => p.modelId === modelId);
      if (!preset) {
        return { ok: false, reason: `"${modelId}" is not a real available model.` };
      }
      await mutations.createAiCreditTier({
        merchantId,
        modelId: preset.modelId,
        displayName: preset.displayName,
        provider: "groq",
        coinsPerRequest,
      });
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not apply that change." };
  }
}
