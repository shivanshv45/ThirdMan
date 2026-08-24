import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, confirmCapture } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * L4-2/L4-3/L4-5: the capture/hold state machine in gate.ts. Order
 * creation is exercised against real Razorpay test-mode (same as
 * gate.test.ts); confirmCapture itself is pure state-transition logic
 * over money_actions and is tested directly with a synthetic payment id,
 * since completing a real Checkout payment needs a browser and (for some
 * test cards) OTP entry, which no automated test can drive. What matters
 * here — executed -> captured/held, idempotency across the two
 * converging signals (checkout signature vs. webhook), fail-closed on a
 * bad prior state — is all state-machine behaviour, not a claim that a
 * real payment happened.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__capture_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `capture_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__capture_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise: 10_000_000,
      spentPaise: 0,
      perTransactionMaxPaise: 10_000_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();
  return cap;
}

describe("confirmCapture", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    merchantId = undefined;
    agentIds = [];

    if (currentAgentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.escrowHolds).where(eq(schema.escrowHolds.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function setup() {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id);
    return { merchantId, agent };
  }

  async function createExecutedOrder(holdOnly = false) {
    const { merchantId, agent } = await setup();
    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 20_000,
      context: "capture test order",
      holdOnly,
    });
    expect(result.decision).toBe("allow");
    return { merchantId, moneyActionId: result.moneyActionId! };
  }

  it("transitions executed -> captured on a normal (non-hold) order", async () => {
    const { moneyActionId } = await createExecutedOrder(false);

    const result = await confirmCapture(moneyActionId, "pay_test_synthetic_1", "checkout_signature");
    expect(result.decision).toBe("allow");

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("captured");
    expect(action.razorpayPaymentId).toBe("pay_test_synthetic_1");
  }, 20_000);

  it("transitions executed -> held (not captured) when the order was created with holdOnly, and records an escrow_holds row", async () => {
    const { merchantId, moneyActionId } = await createExecutedOrder(true);

    const result = await confirmCapture(moneyActionId, "pay_test_synthetic_2", "checkout_signature");
    expect(result.decision).toBe("allow");

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("held");

    const [hold] = await db.select().from(schema.escrowHolds).where(eq(schema.escrowHolds.moneyActionId, moneyActionId));
    expect(hold).toBeDefined();
    expect(hold.merchantId).toBe(merchantId);
    expect(hold.outcome).toBe("held");
    expect(hold.expiresAt.getTime()).toBeGreaterThan(Date.now());
  }, 20_000);

  it("is idempotent: a second confirmation of an already-captured action is a no-op, not an error", async () => {
    const { moneyActionId } = await createExecutedOrder(false);

    const first = await confirmCapture(moneyActionId, "pay_test_synthetic_3", "checkout_signature");
    expect(first.decision).toBe("allow");

    // The webhook arriving after the checkout signature already confirmed it.
    const second = await confirmCapture(moneyActionId, "pay_test_synthetic_3", "webhook");
    expect(second.decision).toBe("allow");
    expect(second.reason).toMatch(/already captured/i);

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("captured");
  }, 20_000);

  it("fails closed: cannot capture a money action that was never allowed", async () => {
    const { merchantId, agent } = await setup();
    // A revoked agent guarantees a deny, so no money_actions row with status "executed" exists.
    await db.update(schema.agents).set({ status: "revoked" }).where(eq(schema.agents.id, agent.id));

    const denyResult = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "should be denied",
    });
    expect(denyResult.decision).toBe("deny");
    expect(denyResult.moneyActionId).toBeUndefined();

    // No money_actions row exists at all for a bound-check deny, so
    // confirmCapture against a random id must throw rather than fabricate a row.
    await expect(confirmCapture("00000000-0000-0000-0000-000000000000", "pay_x", "webhook")).rejects.toThrow(/no money action found/i);
  });
}, 30_000);
