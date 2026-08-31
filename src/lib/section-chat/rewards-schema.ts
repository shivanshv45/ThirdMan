import { z } from "zod";

/**
 * The closed shape a Rewards section-chat proposal must match, shared
 * between rewards-draft.ts (drafts, never writes) and
 * rewards-confirm.ts (writes, never calls a model) so the two can never
 * validate against different grammars. Same isolation discipline as
 * setup-conversation-schema.ts, see section-chat.isolation.test.ts.
 *
 * Only two action kinds exist because that is the entire real surface
 * of /dashboard/rewards' Server Actions (actions.ts): set the coin
 * program's three bounds, or add an AI credit tier from the merchant's
 * own fixed, verified model list. Nothing here can invent a field the
 * manual form does not also have.
 */

const setRewardSettingsProposal = z.object({
  kind: z.literal("set_reward_settings"),
  paisePerCoinRupees: z.number().positive().finite(),
  issueRatePermille: z.number().int().min(0).max(1000),
  maxRedemptionPercent: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1).max(240),
});

const addAiCreditTierProposal = z.object({
  kind: z.literal("add_ai_credit_tier"),
  /** Must match one of TIER_PRESETS' modelId values, checked again at confirm time against the real list. */
  modelId: z.string().trim().min(1),
  coinsPerRequest: z.number().int().positive(),
  summary: z.string().trim().min(1).max(240),
});

/** The merchant clearly wants a real action but a required number or field is still missing. */
const clarifyProposal = z.object({
  kind: z.literal("clarify"),
  question: z.string().trim().min(1).max(240),
});

/** Nothing to change, or the request wasn't about a real Rewards action at all. */
const noActionProposal = z.object({
  kind: z.literal("no_action"),
  summary: z.string().trim().min(1).max(240),
});

export const rewardsProposalSchema = z.discriminatedUnion("kind", [
  setRewardSettingsProposal,
  addAiCreditTierProposal,
  clarifyProposal,
  noActionProposal,
]);

export type RewardsProposal = z.infer<typeof rewardsProposalSchema>;

export const REWARDS_SCHEMA_DESCRIPTION = `{"kind": "set_reward_settings" | "add_ai_credit_tier" | "clarify" | "no_action", ...}. For "set_reward_settings": {"kind": "set_reward_settings", "paisePerCoinRupees": number (rupees each coin is worth, positive), "issueRatePermille": integer 0-1000 (coins issued per 1000 rupees of a captured purchase), "maxRedemptionPercent": integer 0-100 (max share of a single purchase payable in coins), "summary": one sentence stating the exact new values in plain rupees/percent}. For "add_ai_credit_tier": {"kind": "add_ai_credit_tier", "modelId": the exact model id from the merchant's real available list given below, "coinsPerRequest": positive integer, "summary": one sentence}. If the merchant clearly wants one of these two actions but a required number is missing, return {"kind": "clarify", "question": one short specific question for the single most important missing thing} — never guess a number the merchant did not state or clearly imply, and never ask for everything at once. If the instruction does not relate to rewards at all, return {"kind": "no_action", "summary": one sentence explaining why}. Never invent a modelId not in the given list.`;
