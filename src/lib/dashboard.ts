import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getRecentAuditEntries } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";

/**
 * Read queries for the merchant dashboard. Every function is scoped by
 * merchantId, resolved from the session by the caller — see
 * src/lib/auth.ts's getSessionMerchant/requireSessionMerchant.
 */

export interface AgentWithCap {
  id: string;
  name: string;
  status: (typeof schema.agentStatusEnum.enumValues)[number];
  cap: {
    id: string;
    capPaise: number;
    spentPaise: number;
    remainingPaise: number;
    perTransactionMaxPaise: number;
    windowStart: Date;
    windowEnd: Date;
    status: (typeof schema.spendCapStatusEnum.enumValues)[number];
  } | null;
}

export async function getAgentsWithCaps(merchantId: string): Promise<AgentWithCap[]> {
  const agents = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.merchantId, merchantId))
    .orderBy(desc(schema.agents.createdAt));

  if (agents.length === 0) return [];

  // One query for every agent's spend caps rather than one query per
  // agent — the previous version issued a query per row in the loop.
  // The most recent cap per agent is picked in memory below, same
  // "latest wins" rule checkBounds uses in gate.ts.
  const allCaps = await db
    .select()
    .from(schema.spendCaps)
    .where(inArray(schema.spendCaps.agentId, agents.map((a) => a.id)))
    .orderBy(desc(schema.spendCaps.createdAt));

  const latestCapByAgentId = new Map<string, typeof schema.spendCaps.$inferSelect>();
  for (const cap of allCaps) {
    if (!latestCapByAgentId.has(cap.agentId)) {
      latestCapByAgentId.set(cap.agentId, cap);
    }
  }

  return agents.map((agent) => {
    const cap = latestCapByAgentId.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      cap: cap
        ? {
            id: cap.id,
            capPaise: cap.capPaise,
            spentPaise: cap.spentPaise,
            remainingPaise: Math.max(cap.capPaise - cap.spentPaise, 0),
            perTransactionMaxPaise: cap.perTransactionMaxPaise,
            windowStart: cap.windowStart,
            windowEnd: cap.windowEnd,
            status: cap.status,
          }
        : null,
    };
  });
}

export async function getAuditTrail(merchantId: string, limit = 100) {
  return getRecentAuditEntries(merchantId, limit);
}

/**
 * Whether a merchant has connected Razorpay, and a masked tail of the key
 * id for display. Never decrypts or returns the secret — the settings
 * page only ever needs to prove "something is connected," not the value.
 */
export async function getRazorpayConnectionStatus(
  merchantId: string,
): Promise<{ connected: boolean; maskedKeyId?: string }> {
  const [merchant] = await db
    .select({
      keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted,
      keySecretEncrypted: schema.merchants.razorpayKeySecretEncrypted,
    })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant?.keyIdEncrypted || !merchant?.keySecretEncrypted) {
    return { connected: false };
  }

  const keyId = decrypt(merchant.keyIdEncrypted);
  return { connected: true, maskedKeyId: `${keyId.slice(0, 8)}••••${keyId.slice(-4)}` };
}

export interface PendingEscalationRow {
  id: string;
  riskReason: string;
  createdAt: Date;
  moneyAction: {
    id: string;
    amountPaise: number;
    type: (typeof schema.moneyActionTypeEnum.enumValues)[number];
  };
  agent: { id: string; name: string } | null;
}

/** A merchant's own catalogue, newest first. Includes archived products so the dashboard can show and reactivate them. */
export async function getProducts(merchantId: string) {
  return db
    .select()
    .from(schema.products)
    .where(eq(schema.products.merchantId, merchantId))
    .orderBy(desc(schema.products.createdAt));
}

export interface EscrowHoldRow {
  id: string;
  outcome: (typeof schema.escrowHoldOutcomeEnum.enumValues)[number];
  expiresAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  moneyAction: {
    id: string;
    amountPaise: number;
    status: (typeof schema.moneyActionStatusEnum.enumValues)[number];
    productId: string | null;
  };
  productName: string | null;
}

/** Every escrow hold for a merchant, newest first — including resolved ones, so the dashboard can show history, not just what's currently held. */
export async function getEscrowHolds(merchantId: string): Promise<EscrowHoldRow[]> {
  const rows = await db
    .select({
      hold: schema.escrowHolds,
      moneyAction: schema.moneyActions,
      productName: schema.products.name,
    })
    .from(schema.escrowHolds)
    .innerJoin(schema.moneyActions, eq(schema.escrowHolds.moneyActionId, schema.moneyActions.id))
    .leftJoin(schema.products, eq(schema.moneyActions.productId, schema.products.id))
    .where(eq(schema.escrowHolds.merchantId, merchantId))
    .orderBy(desc(schema.escrowHolds.createdAt));

  return rows.map((r) => ({
    id: r.hold.id,
    outcome: r.hold.outcome,
    expiresAt: r.hold.expiresAt,
    resolvedAt: r.hold.resolvedAt,
    createdAt: r.hold.createdAt,
    moneyAction: {
      id: r.moneyAction.id,
      amountPaise: r.moneyAction.amountPaise,
      status: r.moneyAction.status,
      productId: r.moneyAction.productId,
    },
    productName: r.productName,
  }));
}

export async function getPendingEscalations(merchantId: string): Promise<PendingEscalationRow[]> {
  const rows = await db
    .select({
      escalation: schema.escalations,
      moneyAction: schema.moneyActions,
      agent: schema.agents,
    })
    .from(schema.escalations)
    .innerJoin(schema.moneyActions, eq(schema.escalations.moneyActionId, schema.moneyActions.id))
    .leftJoin(schema.agents, eq(schema.moneyActions.agentId, schema.agents.id))
    .where(and(eq(schema.escalations.outcome, "pending"), eq(schema.moneyActions.merchantId, merchantId)))
    .orderBy(desc(schema.escalations.createdAt));

  return rows.map((r) => ({
    id: r.escalation.id,
    riskReason: r.escalation.riskReason,
    createdAt: r.escalation.createdAt,
    moneyAction: {
      id: r.moneyAction.id,
      amountPaise: r.moneyAction.amountPaise,
      type: r.moneyAction.type,
    },
    agent: r.agent ? { id: r.agent.id, name: r.agent.name } : null,
  }));
}
