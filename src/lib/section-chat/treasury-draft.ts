import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { getTreasurySettings } from "@/lib/treasury";
import { treasuryProposalSchema, TREASURY_SCHEMA_DESCRIPTION, type TreasuryProposal } from "./treasury-schema";

/**
 * The Treasury section chat bar's model-facing half. No import of
 * treasury-confirm.ts — see section-chat/treasury.isolation.test.ts.
 */

export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftResult {
  ok: boolean;
  proposal?: TreasuryProposal;
  question?: string;
  reason?: string;
}

export async function draftTreasuryAction(merchantId: string, history: ChatTurn[]): Promise<DraftResult> {
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "merchant" || !latest.text.trim()) {
    return { ok: false, reason: 'Say what you want, e.g. "give buyers 2x rewards on orders over 1000 rupees".' };
  }

  const verdict = await inspectInbound(latest.text, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction could not be processed. Try plainer terms, or use the buttons below instead." };
  }

  const current = await getTreasurySettings(merchantId);
  const transcript = history.map((t) => `${t.role === "merchant" ? "Merchant" : "You"}: ${t.text}`).join("\n");

  try {
    const { data } = await completeStructured({
      prompt: `You manage the AI treasury (reward funding split, reward-multiplier rules, and model spend budgets) on a merchant dashboard's Treasury section, talking with a merchant who may be vague and expects you to ask for whatever specific detail is missing. The merchant's current treasury settings (basis points, 10000 = 100%) are: ${JSON.stringify(current)}\n\nConversation so far:\n${transcript}\n\nMap it onto exactly one real action, ask one clarifying question if something required is missing, or say it doesn't match any. Toggling or removing an existing rule is not supported here; only creating a new one is.`,
      schema: treasuryProposalSchema,
      schemaDescription: TREASURY_SCHEMA_DESCRIPTION,
    });

    const parsed = treasuryProposalSchema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, reason: `Could not draft a valid action: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }

    if (parsed.data.kind === "clarify") {
      return { ok: false, question: parsed.data.question };
    }

    if (parsed.data.kind === "no_action") {
      return { ok: false, reason: parsed.data.summary };
    }

    if (parsed.data.kind === "set_treasury_settings") {
      const { buyerPercent, merchantPercent, reservePercent } = parsed.data;
      if (Math.round(buyerPercent + merchantPercent + reservePercent) !== 100) {
        return { ok: false, reason: "Buyer, merchant, and reserve percent must add up to 100." };
      }
    }

    return { ok: true, proposal: parsed.data };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "The model is unavailable right now. Use the buttons below instead." };
  }
}
