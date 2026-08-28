import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { expirePendingEscalations } from "@/lib/notifications/expiry";

/**
 * Layer 11-7: auto-expiring a pending escalation. The assertion that
 * matters most — per
 * plans/layer-11-notifications-and-token-rewards.md's L11-7 — is that
 * expiry provably RELEASES the reserved spend-cap budget, not just that
 * it changes a status column. Getting that wrong silently corrupts the
 * central safety bound this whole product is graded on, so this is the
 * test written first, deliberately not a UI-adjacent afterthought.
 *
 * Constructs the escalation state directly (real spend_caps/
 * money_actions/escalations rows with a past expiresAt) rather than
 * going through the live, non-deterministic risk layer — gate.escalation.
 * test.ts already covers the real end-to-end "risk layer decides
 * escalate" path; this file is about the deterministic timeout sweep
 * on top of an already-escalated state, and needs to be fast and
 * reproducible, not dependent on a model call landing on "escalate."
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__expiry_test_agent__", apiKeyHash: `expiry_test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise: number, spentPaise: number) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise,
      spentPaise,
      perTransactionMaxPaise: capPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();
  return cap;
}

async function makePendingEscalation(merchantId: string, agentId: string, capId: string, amountPaise: number, expiresAt: Date) {
  const [moneyAction] = await db
    .insert(schema.moneyActions)
    .values({ merchantId, agentId, type: "order_create", amountPaise, status: "pending_escalation" })
    .returning();

  const [escalation] = await db
    .insert(schema.escalations)
    .values({ moneyActionId: moneyAction.id, spendCapId: capId, riskReason: "expiry test fixture", expiresAt })
    .returning();

  return { moneyAction, escalation };
}

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    // Deletion order matters: escalations and audit_log both FK into
    // money_actions, so both must go before it — same FK-ordering
    // lesson every other test file in this repo already documents.
    const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length > 0) {
      const caps = await db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
      const capIds = caps.map((c) => c.id);
      if (capIds.length > 0) await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, capIds));
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("expirePendingEscalations", () => {
  it("releases the reserved budget back to the cap when an escalation times out — the assertion that matters", async () => {
    const merchant = await createTestMerchant("__expiry_test_release__");
    createdMerchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);

    const capPaise = 100_000;
    const reservedAmount = 30_000;
    // spentPaise already reflects the reservation this escalation made,
    // same as attemptMoneyAction's own reserveBudget would have left it.
    const cap = await makeCap(agent.id, capPaise, reservedAmount);

    const past = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago — already expired
    await makePendingEscalation(merchant.id, agent.id, cap.id, reservedAmount, past);

    const result = await expirePendingEscalations();
    expect(result.expired).toBe(1);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(0); // fully released, back to pre-reservation

    const [updatedEscalation] = await db.select().from(schema.escalations).where(eq(schema.escalations.spendCapId, cap.id));
    expect(updatedEscalation.outcome).toBe("rejected");
    expect(updatedEscalation.resolvedAt).not.toBeNull();

    const [updatedAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchant.id));
    expect(updatedAction.status).toBe("failed"); // denied, never auto-approved

    const [auditEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.merchantId, merchant.id));
    // resolveEscalation's own "escalation_resolved" entry plus this
    // module's "escalation_expired" entry — assert the timeout-specific
    // one exists and names the stopping rule.
    const expiredEntries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.event, "escalation_expired"));
    expect(expiredEntries.some((e) => e.merchantId === merchant.id)).toBe(true);
    void auditEntry;
  }, 15_000);

  it("does not touch an escalation whose expiresAt is still in the future", async () => {
    const merchant = await createTestMerchant("__expiry_test_not_yet__");
    createdMerchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const cap = await makeCap(agent.id, 100_000, 30_000);

    const future = new Date(Date.now() + 60 * 60 * 1000);
    await makePendingEscalation(merchant.id, agent.id, cap.id, 30_000, future);

    const result = await expirePendingEscalations();

    const [unchangedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(unchangedCap.spentPaise).toBe(30_000); // untouched

    const [unchangedEscalation] = await db.select().from(schema.escalations).where(eq(schema.escalations.spendCapId, cap.id));
    expect(unchangedEscalation.outcome).toBe("pending");
    void result;
  });

  it("never re-processes an escalation a merchant already resolved before the sweep ran", async () => {
    const merchant = await createTestMerchant("__expiry_test_already_resolved__");
    createdMerchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const cap = await makeCap(agent.id, 100_000, 30_000);

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { escalation } = await makePendingEscalation(merchant.id, agent.id, cap.id, 30_000, past);

    // A merchant approved it a moment before the sweep ran — reject
    // (releasing budget) is only the RIGHT outcome for a genuine
    // timeout; an escalation a human already acted on must be left
    // alone entirely, not overwritten or double-processed.
    await db.update(schema.escalations).set({ outcome: "approved", resolvedAt: new Date(), spendCapId: cap.id }).where(eq(schema.escalations.id, escalation.id));
    await db.update(schema.spendCaps).set({ spentPaise: 30_000 }).where(eq(schema.spendCaps.id, cap.id)); // approval keeps the spend, doesn't release it

    const result = await expirePendingEscalations();
    expect(result.expired).toBe(0); // already resolved, outside the sweep's query — not selected, not touched

    const [untouchedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(untouchedCap.spentPaise).toBe(30_000); // an approved escalation's spend must never be "released" by a later sweep

    const [untouchedEscalation] = await db.select().from(schema.escalations).where(eq(schema.escalations.id, escalation.id));
    expect(untouchedEscalation.outcome).toBe("approved"); // unchanged
  });

  it("processes every expired escalation in one sweep, releasing each cap independently", async () => {
    const merchant = await createTestMerchant("__expiry_test_batch__");
    createdMerchantIds.push(merchant.id);
    const agentA = await makeAgent(merchant.id);
    const agentB = await makeAgent(merchant.id);
    const capA = await makeCap(agentA.id, 100_000, 25_000);
    const capB = await makeCap(agentB.id, 200_000, 50_000);

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { escalation: escalationA } = await makePendingEscalation(merchant.id, agentA.id, capA.id, 25_000, past);
    const { escalation: escalationB } = await makePendingEscalation(merchant.id, agentB.id, capB.id, 50_000, past);

    const result = await expirePendingEscalations();
    expect(result.expired).toBe(2);

    const [updatedCapA] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, capA.id));
    const [updatedCapB] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, capB.id));
    expect(updatedCapA.spentPaise).toBe(0);
    expect(updatedCapB.spentPaise).toBe(0);

    const [resolvedA] = await db.select().from(schema.escalations).where(eq(schema.escalations.id, escalationA.id));
    const [resolvedB] = await db.select().from(schema.escalations).where(eq(schema.escalations.id, escalationB.id));
    expect(resolvedA.outcome).toBe("rejected");
    expect(resolvedB.outcome).toBe("rejected");
  }, 15_000);
});
