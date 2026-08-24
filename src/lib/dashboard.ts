import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getRecentAuditEntries } from "@/lib/audit";

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

  const result: AgentWithCap[] = [];
  for (const agent of agents) {
    const [cap] = await db
      .select()
      .from(schema.spendCaps)
      .where(eq(schema.spendCaps.agentId, agent.id))
      .orderBy(desc(schema.spendCaps.createdAt))
      .limit(1);

    result.push({
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
    });
  }

  return result;
}

export async function getAuditTrail(merchantId: string, limit = 100) {
  return getRecentAuditEntries(merchantId, limit);
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
    .where(eq(schema.escalations.outcome, "pending"))
    .orderBy(desc(schema.escalations.createdAt));

  return rows
    .filter((r) => r.moneyAction.merchantId === merchantId)
    .map((r) => ({
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
