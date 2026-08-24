import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * The framework-agnostic core of every dashboard mutation. Separated
 * from src/app/dashboard/actions.ts so this logic is directly testable
 * without a Next.js request context — revalidatePath() throws outside
 * one, which the thin Server Action wrappers call after these return.
 */

/** Loads an agent and throws unless it belongs to the given merchant, so no mutation can act on another merchant's agent by id alone. */
async function requireOwnedAgent(merchantId: string, agentId: string) {
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchantId)));

  if (!agent) throw new Error("Agent not found");
  return agent;
}

export interface SetSpendCapInput {
  merchantId: string;
  agentId: string;
  capRupees: number;
  perTransactionMaxRupees: number;
  windowHours: number;
}

export async function setSpendCap(input: SetSpendCapInput) {
  if (!input.agentId || !Number.isFinite(input.capRupees) || input.capRupees <= 0) {
    throw new Error("Invalid cap parameters");
  }

  await requireOwnedAgent(input.merchantId, input.agentId);

  const capPaise = Math.round(input.capRupees * 100);
  const perTransactionMaxPaise = Math.round(input.perTransactionMaxRupees * 100);
  const now = new Date();

  // Revoke any existing active cap for this agent before creating a new
  // one, so checkBounds's "most recent cap" lookup always finds exactly
  // the intended cap and old ones don't linger as stale active rows.
  await db.update(schema.spendCaps).set({ status: "revoked" }).where(eq(schema.spendCaps.agentId, input.agentId));

  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: input.agentId,
      capPaise,
      spentPaise: 0,
      perTransactionMaxPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + input.windowHours * 60 * 60 * 1000),
      status: "active",
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "spend_cap_set",
    decision: "n/a",
    reason: `Merchant set a new spend cap of ₹${input.capRupees.toFixed(2)} (₹${input.perTransactionMaxRupees.toFixed(2)} per transaction, ${input.windowHours}h window) for agent ${input.agentId}.`,
    boundApplied: `spend_cap:${cap.id}`,
  });

  return cap;
}

export async function revokeAgent(merchantId: string, agentId: string) {
  if (!agentId) throw new Error("Missing agentId");
  await requireOwnedAgent(merchantId, agentId);

  const [agent] = await db
    .update(schema.agents)
    .set({ status: "revoked" })
    .where(eq(schema.agents.id, agentId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_revoked",
    decision: "n/a",
    reason: `Merchant revoked agent "${agent.name}". It will be denied on its next transaction attempt.`,
  });

  return agent;
}

export async function reactivateAgent(merchantId: string, agentId: string) {
  if (!agentId) throw new Error("Missing agentId");
  await requireOwnedAgent(merchantId, agentId);

  const [agent] = await db
    .update(schema.agents)
    .set({ status: "active" })
    .where(eq(schema.agents.id, agentId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_reactivated",
    decision: "n/a",
    reason: `Merchant reactivated agent "${agent.name}".`,
  });

  return agent;
}
