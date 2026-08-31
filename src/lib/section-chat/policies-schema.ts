import { z } from "zod";

export const policiesProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_policy"),
    returnsAccepted: z.boolean(),
    returnWindowDays: z.number().int().nonnegative().nullable(),
    refundMethod: z.enum(["original_payment_method", "store_credit", "either"]).nullable(),
    restockingFeePercent: z.number().nonnegative().nullable(),
    shippingRegions: z.array(z.string()),
    handlingTimeDays: z.number().int().nonnegative().nullable(),
    warrantyMonths: z.number().int().nonnegative().nullable(),
    policyNotes: z.string().default(""),
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

export type PoliciesProposal = z.infer<typeof policiesProposalSchema>;

export const POLICIES_SCHEMA_DESCRIPTION = `
One of:
- set_policy: { kind: "set_policy", returnsAccepted, returnWindowDays, refundMethod, restockingFeePercent, shippingRegions, handlingTimeDays, warrantyMonths, policyNotes, summary }
  Replaces the merchant's whole return/refund/shipping policy. shippingRegions is an array of upper-case region codes (e.g. ["IN","US"]). Use null for any field the merchant didn't mention and that has no sane default — never invent a number. If the merchant is only changing one field, still carry over the other current values passed in the prompt context (there is no need to re-ask about fields already known from the current policy).
- clarify: { kind: "clarify", question }
  Use when there is no current policy yet and the merchant's instruction is missing a number needed to set a sane one (most commonly the return window in days, if they said returns are accepted). Ask ONE short question for the single most important missing thing.
- no_action: { kind: "no_action", summary }
  Use when the instruction doesn't relate to policy at all. Explain why in summary.
`.trim();
