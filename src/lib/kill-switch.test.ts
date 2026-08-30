import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freezeAllAgents, unfreezeAllAgents, isFrozen, getGuardianState, evaluateAndTransition } from "@/lib/guardian";
import { attemptMoneyAction } from "@/lib/gate";
import { expirePendingEscalations } from "@/lib/notifications/expiry";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 25-2: the Kill Switch. Tests the plan's own required properties
 * directly, against the real DB and the real gate — never asserted by
 * inspecting a UI state:
 * - atomic and complete (every active agent frozen, or none)
 * - a frozen agent's real purchase is genuinely denied by the gate
 * - a pending escalation is HELD, not auto-resolved, while frozen
 * - unfreeze restores prior state, including an agent already suspended
 *   before the freeze
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__killswitch_test_${Date.now()}_${Math.random()}__`,
      email: `killswitch_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string, name = "__killswitch_test_agent__") {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name, apiKeyHash: `ks_test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise = 100_000_000) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({ agentId, capPaise, spentPaise: 0, perTransactionMaxPaise: capPaise, windowStart: now, windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000), status: "active" })
    .returning();
  return cap;
}

describe("Kill Switch — real DB, real gate integration", () => {
  const merchantIds: string[] = [];
  const agentIds: string[] = [];

  afterEach(async () => {
    const currentMerchantIds = [...merchantIds];
    const currentAgentIds = [...agentIds];
    merchantIds.length = 0;
    agentIds.length = 0;

    if (currentAgentIds.length > 0) {
      await db.delete(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.relatedEntityId, currentAgentIds));
      await db.delete(schema.agentFreezeSnapshots).where(inArray(schema.agentFreezeSnapshots.agentId, currentAgentIds));
      await db.delete(schema.guardianTransitions).where(inArray(schema.guardianTransitions.agentId, currentAgentIds));
      await db.delete(schema.agentGuardianState).where(inArray(schema.agentGuardianState.agentId, currentAgentIds));
      await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds))));
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    for (const merchantId of currentMerchantIds) {
      await db.delete(schema.merchantFreezes).where(eq(schema.merchantFreezes.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("freezes every active agent atomically, and a real purchase attempt is genuinely denied by the gate afterward", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const agentOne = await makeAgent(merchant.id, "__ks_agent_one__");
    agentIds.push(agentOne.id);
    const agentTwo = await makeAgent(merchant.id, "__ks_agent_two__");
    agentIds.push(agentTwo.id);
    await makeCap(agentOne.id);
    await makeCap(agentTwo.id);

    expect(await isFrozen(merchant.id)).toBe(false);

    const { agentsFrozen } = await freezeAllAgents(merchant.id, "suspicious activity — testing the switch");
    expect(agentsFrozen).toBe(2);
    expect(await isFrozen(merchant.id)).toBe(true);
    expect(await getGuardianState(agentOne.id)).toBe("suspended");
    expect(await getGuardianState(agentTwo.id)).toBe("suspended");

    // The real gate, real bound — not a UI assertion.
    const attempt = await attemptMoneyAction({
      agentId: agentOne.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 1000,
      context: "should be denied — the Kill Switch is thrown",
    });
    expect(attempt.decision).toBe("deny");
    expect(attempt.reason).toMatch(/suspended/i);

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agentOne.id));
    expect(cap.spentPaise).toBe(0);
  }, 30_000);

  it("throwing the switch twice without unfreezing is refused, never silently re-freezing", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);
    await makeCap(agent.id);

    await freezeAllAgents(merchant.id, "first freeze");
    await expect(freezeAllAgents(merchant.id, "second freeze")).rejects.toThrow(/already frozen/i);
  });

  it("unfreeze restores prior state — an agent already suspended BEFORE the freeze stays suspended after unfreeze, a normal one returns to normal", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const alreadySuspended = await makeAgent(merchant.id, "__ks_already_suspended__");
    agentIds.push(alreadySuspended.id);
    const normalAgent = await makeAgent(merchant.id, "__ks_normal__");
    agentIds.push(normalAgent.id);
    await makeCap(alreadySuspended.id);
    await makeCap(normalAgent.id);

    // A real prior Guardian suspension, independent of the Kill Switch.
    for (let i = 0; i < 7; i++) {
      await db.insert(schema.moneyActions).values({ merchantId: merchant.id, agentId: alreadySuspended.id, amountPaise: 5000, quantity: 1, type: "order_create", status: "denied" });
    }
    await evaluateAndTransition(alreadySuspended.id);
    await evaluateAndTransition(alreadySuspended.id);
    expect(await getGuardianState(alreadySuspended.id)).toBe("suspended");

    await freezeAllAgents(merchant.id, "testing prior-state restore");
    expect(await getGuardianState(alreadySuspended.id)).toBe("suspended");
    expect(await getGuardianState(normalAgent.id)).toBe("suspended");

    const { agentsRestored } = await unfreezeAllAgents(merchant.id);
    expect(agentsRestored).toBe(2);
    expect(await isFrozen(merchant.id)).toBe(false);

    // The agent that was already suspended stays suspended — the Kill
    // Switch restoring it to "normal" would be a merchant-facing lie
    // about an incident that never went away.
    expect(await getGuardianState(alreadySuspended.id)).toBe("suspended");
    expect(await getGuardianState(normalAgent.id)).toBe("normal");
  }, 30_000);

  it("a pending escalation is HELD, not auto-resolved, while frozen — expirePendingEscalations skips a frozen merchant even past its expiry", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id);

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchant.id, agentId: agent.id, amountPaise: 50_000, quantity: 1, type: "order_create", status: "pending_escalation" })
      .returning();

    // Already past its expiry — expirePendingEscalations would normally
    // auto-deny this on the very next sweep.
    const [escalation] = await db
      .insert(schema.escalations)
      .values({
        moneyActionId: moneyAction.id,
        spendCapId: cap.id,
        riskReason: "kill-switch hold test",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    await freezeAllAgents(merchant.id, "hold the escalation");

    const { expired } = await expirePendingEscalations();
    expect(expired).toBe(0);

    const [row] = await db.select().from(schema.escalations).where(eq(schema.escalations.id, escalation.id));
    expect(row.outcome).toBe("pending");

    await unfreezeAllAgents(merchant.id);
  }, 30_000);

  it("unfreezing when not frozen is refused", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    await expect(unfreezeAllAgents(merchant.id)).rejects.toThrow(/not currently frozen/i);
  });
});
