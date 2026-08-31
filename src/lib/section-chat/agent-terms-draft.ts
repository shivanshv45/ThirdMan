import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { getMerchantAgentTerms } from "@/lib/agent-terms";
import { agentTermsProposalSchema, AGENT_TERMS_SCHEMA_DESCRIPTION, type AgentTermsProposal } from "./agent-terms-schema";

/**
 * The Agent terms section chat bar's model-facing half. No import of
 * agent-terms-confirm.ts — see section-chat/agent-terms.isolation.test.ts.
 * setMerchantAgentTerms is a full replace, so the current row (in
 * paise) is read here and given to the model as context.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: AgentTermsProposal;
  question?: string;
  reason?: string;
}

export async function draftAgentTermsAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want, e.g. "allow unknown agents up to 2000 rupees without a mandate".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the form below instead." };
  }

  const current = await getMerchantAgentTerms(merchantId);
  const transcript = history.map((t) => `${t.role === "merchant" ? "Merchant" : "You"}: ${t.text}`).join("\n");

  try {
    const { data } = await completeStructured({
      prompt: `You manage terms for unregistered AI buyer agents on a merchant dashboard's Agent terms section, talking with a merchant who may be vague and expects you to ask for whatever specific detail is missing. The merchant's current terms (all money fields in paise) are: ${JSON.stringify(current)}\n\nConversation so far:\n${transcript}\n\nProduce the merchant's full new terms in rupees (convert from the paise context above), carrying over every field the conversation didn't mention.`,
      schema: agentTermsProposalSchema,
      schemaDescription: AGENT_TERMS_SCHEMA_DESCRIPTION,
    });

    const parsed = agentTermsProposalSchema.safeParse(data);
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
