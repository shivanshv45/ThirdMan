import { z } from "zod";

const USE_CASE_VALUES = ["support_chat", "recovery_diagnosis", "negotiation", "classification"] as const;
const FIELD_VALUES = ["orderValuePaise", "marginPercent", "priorCaptureCount"] as const;
const OPERATOR_VALUES = ["gt", "gte", "lt", "lte", "eq"] as const;

export const treasuryProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_treasury_settings"),
    allocationPercent: z.number().min(0).max(100),
    buyerPercent: z.number().min(0).max(100),
    merchantPercent: z.number().min(0).max(100),
    reservePercent: z.number().min(0).max(100),
    enabled: z.boolean(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("create_reward_rule"),
    field: z.enum(FIELD_VALUES),
    operator: z.enum(OPERATOR_VALUES),
    value: z.number(),
    multiplierX: z.number().nonnegative(),
    priority: z.number().int().default(0),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("set_model_budget"),
    useCase: z.enum(USE_CASE_VALUES),
    budgetRupees: z.number().nonnegative(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("clarify"),
    question: z.string(),
  }),
  z.object({
    kind: z.literal("no_action"),
    summary: z.string(),
  }),
]);

export type TreasuryProposal = z.infer<typeof treasuryProposalSchema>;

export const TREASURY_SCHEMA_DESCRIPTION = `
One of:
- set_treasury_settings: { kind: "set_treasury_settings", allocationPercent, buyerPercent, merchantPercent, reservePercent, enabled, summary }
  Replaces the merchant's whole AI treasury split. All percents are 0-100. buyerPercent + merchantPercent + reservePercent should sum to 100. Carry over fields the conversation didn't mention from the current settings given as context.
- create_reward_rule: { kind: "create_reward_rule", field, operator, value, multiplierX, priority, summary }
  Adds one new reward-multiplier rule. field is one of ${FIELD_VALUES.join(", ")} (orderValuePaise means order value in rupees here, converted at write time). operator is one of ${OPERATOR_VALUES.join(", ")}. multiplierX is how many times the normal reward rate (e.g. 2 means double).
- set_model_budget: { kind: "set_model_budget", useCase, budgetRupees, summary }
  Sets the monthly model spend budget for one use case. useCase is one of ${USE_CASE_VALUES.join(", ")}. budgetRupees is plain rupees.
- clarify: { kind: "clarify", question }
  Use when the merchant clearly wants one of the above but a required number or field is missing (e.g. a reward rule with no threshold value, or a budget with no amount). Ask ONE short question for the single most important missing thing — never invent a number.
- no_action: { kind: "no_action", summary }
  Use when the instruction doesn't map to any of the above (e.g. toggling/removing an existing rule stays a manual click on that rule's own row). Explain why in summary.
`.trim();
