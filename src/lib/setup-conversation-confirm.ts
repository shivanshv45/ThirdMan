import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { rupeesToPaise } from "@/lib/money";
import { proposalSchema } from "@/lib/setup-conversation-schema";

/**
 * Layer 24-7: the setup conversation's write-facing half. NO import of
 * setup-conversation.ts or llm.ts anywhere in this file — nothing here
 * can call a model, and the only way a caller reaches createProposedAgents
 * is with a proposal object it already has in hand, never a live model
 * call this module makes itself. See setup-conversation.isolation.test.ts.
 */

export interface CreatedAgentSummary {
  agentId: string;
  name: string;
  apiKey: string;
}

/**
 * The merchant's explicit confirmation, and the only function in this
 * file that writes anything. Re-validates the proposal against the
 * identical schema draftSetupProposal used — a proposal round-tripped
 * through a form's hidden fields is trusted no more than a fresh model
 * output would be. Creates the whole batch inside one transaction: a
 * half-configured fleet is worse than none, per the plan.
 */
export async function createProposedAgents(merchantId: string, proposal: unknown): Promise<{ ok: true; created: CreatedAgentSummary[] } | { ok: false; reason: string }> {
  const parsed = proposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: `Proposal failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  const validCapabilities = new Set(schema.agentCapabilityEnum.enumValues);
  const created: CreatedAgentSummary[] = [];

  try {
    await db.transaction(async (tx) => {
      for (const proposedAgent of parsed.data.agents) {
        const rawKey = generateApiKey();
        const [agent] = await tx
          .insert(schema.agents)
          .values({ merchantId, name: proposedAgent.name, apiKeyHash: hashApiKey(rawKey), status: "active" })
          .returning();

        const capPaise = rupeesToPaise(proposedAgent.suggestedCapRupees);
        const perTransactionMaxPaise = rupeesToPaise(proposedAgent.suggestedPerTransactionMaxRupees);
        const now = new Date();
        await tx.insert(schema.spendCaps).values({
          agentId: agent.id,
          capPaise,
          spentPaise: 0,
          perTransactionMaxPaise,
          windowStart: now,
          windowEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
        });

        const deduped = [...new Set(proposedAgent.capabilities)].filter((c) => validCapabilities.has(c as (typeof schema.agentCapabilityEnum.enumValues)[number]));
        if (deduped.length > 0) {
          await tx.insert(schema.agentCapabilities).values(deduped.map((capability) => ({ agentId: agent.id, capability: capability as (typeof schema.agentCapabilityEnum.enumValues)[number] })));
        }

        created.push({ agentId: agent.id, name: agent.name, apiKey: rawKey });
      }
    });
  } catch (err) {
    return { ok: false, reason: `Could not create the proposed agents: ${err instanceof Error ? err.message : String(err)}` };
  }

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "setup_conversation_confirmed",
    decision: "n/a",
    reason: `Merchant confirmed a setup-conversation proposal and created ${created.length} agent(s): ${created.map((c) => c.name).join(", ")}. Every cap and capability was proposed by the assistant and confirmed by the merchant before any row was written.`,
    metadata: { agentIds: created.map((c) => c.agentId) },
  });

  return { ok: true, created };
}
