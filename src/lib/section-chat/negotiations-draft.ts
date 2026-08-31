import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { negotiationsProposalSchema, NEGOTIATIONS_SCHEMA_DESCRIPTION, type NegotiationsProposal } from "./negotiations-schema";

/**
 * The Negotiations section chat bar's model-facing half. No import of
 * negotiations-confirm.ts — see section-chat/negotiations.isolation.test.ts.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: NegotiationsProposal;
  question?: string;
  reason?: string;
}

export async function draftNegotiationsAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want, e.g. "set the floor for SKU DARK-500 to 380 rupees".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the form below instead." };
  }

  const transcript = history.map((t) => `${t.role === "merchant" ? "Merchant" : "You"}: ${t.text}`).join("\n");

  try {
    const { data } = await completeStructured({
      prompt: `You manage negotiation floors on a merchant dashboard's Negotiations section, talking with a merchant who may be vague and expects you to ask for whatever specific detail is missing. Conversation so far:\n${transcript}\n\nMap it onto exactly one real action, ask one clarifying question if something required is missing, or say it doesn't match either. The merchant must name a specific SKU; never guess one.`,
      schema: negotiationsProposalSchema,
      schemaDescription: NEGOTIATIONS_SCHEMA_DESCRIPTION,
    });

    const parsed = negotiationsProposalSchema.safeParse(data);
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
