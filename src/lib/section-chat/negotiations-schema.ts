import { z } from "zod";

export const negotiationsProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_floor"),
    sku: z.string().min(1),
    floorPriceRupees: z.number().positive().nullable(),
    belowCostAcknowledged: z.boolean().default(false),
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

export type NegotiationsProposal = z.infer<typeof negotiationsProposalSchema>;

export const NEGOTIATIONS_SCHEMA_DESCRIPTION = `
One of:
- set_floor: { kind: "set_floor", sku, floorPriceRupees, belowCostAcknowledged, summary }
  Sets (or clears, with floorPriceRupees null) the negotiation floor for the variant with this SKU. floorPriceRupees is plain rupees, not paise. Set belowCostAcknowledged true only if the merchant explicitly says they know the floor is below cost.
- clarify: { kind: "clarify", question }
  Use when the merchant clearly wants to set a floor but left out the SKU or the floor price. Ask ONE short question for the single most important missing thing — never guess a SKU or a price.
- no_action: { kind: "no_action", summary }
  Use when the instruction doesn't relate to negotiation floors at all, or asks to view a transcript rather than change a floor (transcripts stay a manual view). Explain why in summary.
`.trim();
