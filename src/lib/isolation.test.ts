import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAgentsWithCaps, getAuditTrail, getPendingEscalations, getMemoryOverview } from "@/lib/dashboard";
import { setSpendCap, revokeAgent, reactivateAgent } from "@/lib/dashboard-mutations";
import { resolveEscalation, ESCALATION_EXPIRY_HOURS } from "@/lib/gate";
import { logAuditEntry } from "@/lib/audit";
import { deleteMemory, correctMemory } from "@/lib/memory/retrieve";

/**
 * Merchant isolation is a bound like any other CLAUDE.md bound, and it's
 * the one whose failure is worst: a leak here crosses money, not just
 * data. This file exists to prove isolation the hard way — by attempting
 * an action on merchant A's data WHILE AUTHENTICATED AS MERCHANT B, using
 * A's real id. An empty-list assertion (does B's own list contain
 * anything?) would still pass even if every ownership check were
 * deleted, as long as seed data didn't happen to overlap. Enumeration by
 * id is what actually proves the check exists.
 *
 * Escalations here are inserted directly rather than driven through
 * attemptMoneyAction's real risk layer, since that risk assessment is a
 * live LLM call and not deterministic about which amounts escalate —
 * these tests are about ownership checks, not risk judgment, so they
 * don't need a real Razorpay/LLM round trip at all.
 */

interface Fixture {
  merchantA: { id: string };
  merchantB: { id: string };
  agentA: { id: string };
  agentB: { id: string };
}

let fixture: Fixture | undefined;

async function makeMerchant(name: string) {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name,
      email: `${name}_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string, name: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name, apiKeyHash: `isolation_test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise = 100_000) {
  const now = new Date();
  await db.insert(schema.spendCaps).values({
    agentId,
    capPaise,
    spentPaise: 0,
    perTransactionMaxPaise: capPaise,
    windowStart: now,
    windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    status: "active",
  });
}

async function setup(): Promise<Fixture> {
  const merchantA = await makeMerchant(`__isolation_test_a_${Date.now()}_${Math.random()}__`);
  const merchantB = await makeMerchant(`__isolation_test_b_${Date.now()}_${Math.random()}__`);
  const agentA = await makeAgent(merchantA.id, "__isolation_test_agent_a__");
  const agentB = await makeAgent(merchantB.id, "__isolation_test_agent_b__");
  await makeCap(agentA.id);
  await makeCap(agentB.id);

  fixture = { merchantA, merchantB, agentA, agentB };
  return fixture;
}

afterEach(async () => {
  if (!fixture) return;
  const { merchantA, merchantB } = fixture;
  fixture = undefined;

  for (const merchantId of [merchantA.id, merchantB.id]) {
    await db
      .delete(schema.escalations)
      .where(
        inArray(
          schema.escalations.spendCapId,
          db
            .select({ id: schema.spendCaps.id })
            .from(schema.spendCaps)
            .where(inArray(schema.spendCaps.agentId, db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId)))),
        ),
      );
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    await db.delete(schema.agentMemories).where(eq(schema.agentMemories.merchantId, merchantId));
    await db
      .delete(schema.spendCaps)
      .where(inArray(schema.spendCaps.agentId, db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId))));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
});

describe("merchant isolation — enumeration by id, not just empty-list", () => {
  it("B's reads return nothing of A's, even though A has real data", async () => {
    const { merchantA, merchantB, agentA } = await setup();

    const agentsB = await getAgentsWithCaps(merchantB.id);
    expect(agentsB.some((a) => a.id === agentA.id)).toBe(false);

    const auditB = await getAuditTrail(merchantB.id, 100);
    expect(auditB.length).toBe(0);

    // Give A a pending escalation directly (not through the real risk
    // layer, which is non-deterministic) so B's pending-escalations read
    // has real cross-tenant data to filter out, not just an empty world.
    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agentA.id));
    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchantA.id, agentId: agentA.id, type: "order_create", amountPaise: 95_000, status: "pending_escalation" })
      .returning();
    await db.insert(schema.escalations).values({
      moneyActionId: moneyAction.id,
      spendCapId: cap.id,
      riskReason: "isolation test fixture",
      expiresAt: new Date(Date.now() + ESCALATION_EXPIRY_HOURS * 60 * 60 * 1000),
    });

    const escalationsB = await getPendingEscalations(merchantB.id);
    expect(escalationsB.some((e) => e.moneyAction.id === moneyAction.id)).toBe(false);
  });

  it("B cannot set A's spend cap by supplying A's agent id", async () => {
    const { merchantB, agentA } = await setup();

    await expect(
      setSpendCap({
        merchantId: merchantB.id,
        agentId: agentA.id,
        capRupees: 999,
        perTransactionMaxRupees: 999,
        windowHours: 24,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("B cannot revoke A's agent by supplying A's agent id", async () => {
    const { merchantB, agentA } = await setup();

    await expect(revokeAgent(merchantB.id, agentA.id)).rejects.toThrow(/not found/i);

    const [stillActive] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentA.id));
    expect(stillActive.status).toBe("active");
  });

  it("B cannot reactivate A's agent by supplying A's agent id", async () => {
    const { merchantA, merchantB, agentA } = await setup();

    // Revoke it for real first (as A), then confirm B can't flip it back.
    await revokeAgent(merchantA.id, agentA.id);
    await expect(reactivateAgent(merchantB.id, agentA.id)).rejects.toThrow(/not found/i);

    const [stillRevoked] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentA.id));
    expect(stillRevoked.status).toBe("revoked");
  });

  it("B cannot resolve A's escalation by supplying A's escalation id", async () => {
    const { merchantA, merchantB, agentA } = await setup();

    // Inserted directly rather than driven through the real risk layer:
    // this test is about resolveEscalation's ownership check, not about
    // whether a given amount happens to read as risky to a live LLM call.
    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agentA.id));
    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({
        merchantId: merchantA.id,
        agentId: agentA.id,
        type: "order_create",
        amountPaise: 50_000,
        status: "pending_escalation",
      })
      .returning();
    const [escalation] = await db
      .insert(schema.escalations)
      .values({
        moneyActionId: moneyAction.id,
        spendCapId: cap.id,
        riskReason: "isolation test fixture",
        expiresAt: new Date(Date.now() + ESCALATION_EXPIRY_HOURS * 60 * 60 * 1000),
      })
      .returning();

    await expect(resolveEscalation(merchantB.id, escalation.id, "approved")).rejects.toThrow(/does not belong to this merchant/i);

    const [stillPending] = await db.select().from(schema.escalations).where(eq(schema.escalations.id, escalation.id));
    expect(stillPending.outcome).toBe("pending");
  });

  it("an audit entry written for A never appears in B's trail (regression: audit_log.merchant_id leak)", async () => {
    const { merchantA, merchantB } = await setup();

    await logAuditEntry({
      merchantId: merchantA.id,
      actor: "system",
      event: "isolation_regression_check",
      decision: "n/a",
      reason: "This entry belongs to merchant A only and must never appear in merchant B's audit trail.",
    });

    const auditA = await getAuditTrail(merchantA.id, 100);
    expect(auditA.some((e) => e.event === "isolation_regression_check")).toBe(true);

    const auditB = await getAuditTrail(merchantB.id, 100);
    expect(auditB.some((e) => e.event === "isolation_regression_check")).toBe(false);
  });

  it("Layer 18: B's memory overview never contains A's memory, and B cannot delete or correct A's memory by id", async () => {
    const { merchantA, merchantB, agentA } = await setup();

    const [memory] = await db
      .insert(schema.agentMemories)
      .values({
        merchantId: merchantA.id,
        subjectType: "agent",
        subjectId: agentA.id,
        kind: "derived",
        key: "reward_coin_balance",
        value: "42 reward coins",
        sourceType: "reward_coin_ledger",
        sourceId: agentA.id,
        confirmedAt: new Date(),
      })
      .returning();

    const overviewB = await getMemoryOverview(merchantB.id);
    expect(overviewB.some((m) => m.id === memory.id)).toBe(false);

    const deleteResult = await deleteMemory(merchantB.id, memory.id);
    expect(deleteResult.ok).toBe(false);
    const correctResult = await correctMemory(merchantB.id, memory.id, "0 reward coins");
    expect(correctResult.ok).toBe(false);

    const [stillThere] = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.id, memory.id));
    expect(stillThere.value).toBe("42 reward coins");
  });

  // Layer 21-8: self-registration issues an agent scoped to the
  // merchantId in the request body — proven here by registering against
  // merchant A and confirming the row (and its cap) only ever belongs to
  // A, never leaking into B's agent list by id.
  it("self-registration scopes the new agent to the requested merchant only", async () => {
    const { merchantA, merchantB } = await setup();

    const { setMerchantAgentTerms } = await import("@/lib/agent-terms");
    await setMerchantAgentTerms({
      merchantId: merchantA.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: ["products:read"],
      selfRegistrationOpen: true,
      selfRegisterStartingCapPaise: 10_000,
      selfRegisterPerTransactionMaxPaise: 5_000,
    });

    const { registerAgent } = await import("@/lib/agent-registration");
    const result = await registerAgent(merchantA.id, "__isolation_self_reg_agent__", "9.9.9.9");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const agentsForB = await getAgentsWithCaps(merchantB.id);
    expect(agentsForB.some((a) => a.id === result.agent.id)).toBe(false);

    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, result.agent.id));
    expect(row.merchantId).toBe(merchantA.id);

    await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, result.agent.id));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, result.agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, result.agent.id));
    await db.delete(schema.merchantAgentTerms).where(eq(schema.merchantAgentTerms.merchantId, merchantA.id));
  }, 20_000);

  // The registration endpoint refuses a non-existent merchant id
  // (route-level, but the id-enumeration discipline is the same one this
  // file proves everywhere else) — a fabricated id must fail closed, not
  // silently succeed against nothing.
  it("registration against a fabricated merchant id fails closed", async () => {
    const { registerAgent } = await import("@/lib/agent-registration");
    const result = await registerAgent("00000000-0000-0000-0000-000000000000", "__ghost_agent__", "1.1.1.1");
    expect(result.ok).toBe(false);
  });
});
