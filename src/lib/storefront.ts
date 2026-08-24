import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";

/**
 * A human buyer on the public storefront isn't an AI agent, but the gate
 * requires an agents.id for its bound checks (agent status, spend cap
 * lookup). Rather than exempt storefront purchases from that bound, they
 * go through a hidden, per-merchant "storefront" agent with its own
 * spend cap — same pattern as recovery/sequencer.ts's
 * getOrCreateRecoveryAgent, and the same reasoning: every money action
 * answers to a real, visible-in-the-audit-trail cap, never a bypass.
 * Never returned by the dashboard's agent list.
 */
const STOREFRONT_AGENT_NAME = "__storefront_checkout";

export async function getOrCreateStorefrontAgent(merchantId: string) {
  const [existing] = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.merchantId, merchantId), eq(schema.agents.name, STOREFRONT_AGENT_NAME)));

  if (existing) return existing;

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: STOREFRONT_AGENT_NAME,
      apiKeyHash: hashApiKey(generateApiKey()),
      status: "active",
    })
    .returning();

  // A generous default so the storefront isn't blocked out of the gate
  // by an accidental zero-cap default — a merchant can tighten this like
  // any other agent's cap once it's surfaced on the dashboard. The real
  // per-purchase bound is still price/stock from the catalogue, not this
  // cap; this cap exists so a single storefront can't spend unboundedly.
  const now = new Date();
  await db.insert(schema.spendCaps).values({
    agentId: agent.id,
    capPaise: 500_000_00,
    spentPaise: 0,
    perTransactionMaxPaise: 100_000_00,
    windowStart: now,
    windowEnd: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    status: "active",
  });

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "storefront_agent_provisioned",
    decision: "n/a",
    reason: "Provisioned the internal storefront checkout agent and its spend cap on first use. Every human checkout is bounded by this cap the same way any external agent's purchases are.",
    metadata: { agentId: agent.id },
  });

  return agent;
}
