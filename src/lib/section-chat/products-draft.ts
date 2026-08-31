import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { productsProposalSchema, PRODUCTS_SCHEMA_DESCRIPTION, type ProductsProposal } from "./products-schema";

/**
 * The Products section chat bar's model-facing half. No import of
 * products-confirm.ts — see section-chat/products.isolation.test.ts.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: ProductsProposal;
  question?: string;
  reason?: string;
}

export async function draftProductsAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want, e.g. "add a 500g dark roast bag for 450 rupees, 30 in stock".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the form below instead." };
  }

  const transcript = history.map((t) => `${t.role === "merchant" ? "Merchant" : "You"}: ${t.text}`).join("\n");

  try {
    const { data } = await completeStructured({
      prompt: `You manage the product catalogue on a merchant dashboard's Products section, talking with a merchant who may describe what they want vaguely and expects you to ask for whatever specific detail you're missing. Conversation so far:\n${transcript}\n\nMap it onto exactly one real action, ask one clarifying question if something required is missing, or say it doesn't match either. Only creating a brand-new product is supported here; editing or archiving an existing product is not.`,
      schema: productsProposalSchema,
      schemaDescription: PRODUCTS_SCHEMA_DESCRIPTION,
    });

    const parsed = productsProposalSchema.safeParse(data);
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
