import { completeStructured } from "@/lib/llm";
import { inspectInbound } from "@/lib/model-armor";
import { proposalSchema, SCHEMA_DESCRIPTION, type SetupProposal } from "@/lib/setup-conversation-schema";

/**
 * Layer 24-7: the setup conversation's model-facing half — drafts only,
 * never writes a row. A merchant describes what they want in plain
 * English; the model translates it into a proposed fleet of agents,
 * zod-validated against setup-conversation-schema.ts's closed grammar.
 * This file has NO import of setup-conversation-confirm.ts (the only
 * module that ever writes an agent/spend-cap/capability row) — see
 * setup-conversation.isolation.test.ts, the third instance of this
 * exact structural proof after memory (Layer 18) and returns (Layer 22).
 */

/**
 * The model drafts. Armor-inspected first since this is a merchant's
 * own free-text reaching a prompt — "internal" trust level (an
 * authenticated dashboard session, not an anonymous buyer chat) so only
 * the deterministic pattern pass runs, no model escalation cost, still
 * fails closed on a genuine hit. A drafted proposal that fails zod
 * validation is rejected outright here — never partially accepted,
 * never stored, never a row.
 */
export async function draftSetupProposal(merchantId: string, instruction: string): Promise<{ ok: true; proposal: SetupProposal } | { ok: false; reason: string }> {
  const trimmed = instruction.trim();
  if (!trimmed) return { ok: false, reason: "Describe what you want in a sentence or two." };

  const verdict = await inspectInbound(trimmed, { merchantId, trustLevel: "internal" });
  if (!verdict.clean) {
    return { ok: false, reason: "That instruction couldn't be processed. Try describing what you want in plainer terms, or use the manual form instead." };
  }

  try {
    const { data } = await completeStructured({
      prompt: `A merchant running an AI-commerce platform described what they want in plain English: "${trimmed}"\n\nPropose a fleet of agents (1 to 5) that would accomplish this. Each agent needs a short name, a one-sentence purpose in the merchant's own words, a conservative starting spend cap with a one-sentence reason, a per-transaction max no larger than the cap, and the minimum capability set for its stated job. Never propose more agents than the instruction actually calls for.`,
      schema: proposalSchema,
      schemaDescription: SCHEMA_DESCRIPTION,
    });

    const parsed = proposalSchema.safeParse(data);
    if (!parsed.success) {
      return { ok: false, reason: `Drafted proposal failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }

    for (const agent of parsed.data.agents) {
      if (agent.suggestedPerTransactionMaxRupees > agent.suggestedCapRupees) {
        return { ok: false, reason: `Drafted proposal for "${agent.name}" has a per-transaction max larger than its own cap — please try describing the request again.` };
      }
    }

    return { ok: true, proposal: parsed.data };
  } catch (err) {
    return { ok: false, reason: `Could not draft a proposal from that instruction: ${err instanceof Error ? err.message : String(err)}` };
  }
}
