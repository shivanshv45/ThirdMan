import { z } from "zod";

export const productsProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_product"),
    name: z.string().min(1),
    description: z.string().default(""),
    priceRupees: z.number().positive(),
    costRupees: z.number().nonnegative(),
    stock: z.number().int().nonnegative(),
    sku: z.string().default(""),
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

export type ProductsProposal = z.infer<typeof productsProposalSchema>;

export const PRODUCTS_SCHEMA_DESCRIPTION = `
One of:
- create_product: { kind: "create_product", name, description, priceRupees, costRupees, stock, sku, summary }
  Adds a new product with one default variant. priceRupees and costRupees are plain rupees (not paise). Use this whenever the merchant describes a new item to sell and every required field can be filled from the conversation.
- clarify: { kind: "clarify", question }
  Use when the merchant's request is genuinely a new product but is missing information you cannot guess (price, cost, or a usable name/description). Ask ONE short, specific question for the single most important missing thing — never ask for everything at once, and never invent a plausible-sounding price or cost yourself. A missing SKU is not worth asking about; leave it blank.
- no_action: { kind: "no_action", summary }
  Use when the instruction doesn't map to creating a product at all (e.g. it asks to edit or archive an existing product — those stay manual actions on the product's own row). Explain why in summary.
`.trim();
