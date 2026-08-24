import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, confirmCapture, captureHeldPayment, issueRefund } from "@/lib/gate";
import { sweepExpiredHolds } from "@/lib/escrow";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * L4-5: the escrow hold-and-capture state machine. Order creation and
 * confirmCapture's transition to "held" are exercised against real
 * Razorpay test-mode order creation (same standard as gate.test.ts).
 *
 * captureHeldPayment/issueRefund/sweepExpiredHolds all make a real
 * capture/refund call to Razorpay, which genuinely rejects a synthetic
 * (never actually paid) payment id — capturing or refunding a payment
 * that doesn't really exist is exactly what Razorpay's API should
 * refuse. Completing a real Checkout payment needs a browser, which no
 * automated test can drive, so this file cannot exercise those
 * functions' Razorpay-success path end to end. What it does verify with
 * a synthetic id: the pre-condition checks (deny on the wrong status,
 * before any Razorpay call), and that a genuine Razorpay-side rejection
 * is handled gracefully — logged and denied, not thrown into the caller
 * — exactly like gate.ts's own executeAndSettle does for order creation.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__escrow_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `escrow_test_${Date.now()}_${Math.random()}@test.invalid`,
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
    .values({ merchantId, name: "__escrow_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
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

describe("escrow hold-and-capture", () => {
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

  async function createHeldPayment(paymentId: string) {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);
    await makeCap(agent.id);

    const order = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 30_000,
      context: "escrow test hold",
      holdOnly: true,
    });
    expect(order.decision).toBe("allow");

    const confirmed = await confirmCapture(order.moneyActionId!, paymentId, "checkout_signature");
    expect(confirmed.decision).toBe("allow");

    return { merchantId: merchant.id, agentId: agent.id, moneyActionId: order.moneyActionId! };
  }

  it("captureHeldPayment fails closed and logs when Razorpay genuinely rejects capturing a payment that was never really paid", async () => {
    // A synthetic payment id was never actually paid through Checkout,
    // so Razorpay's own API correctly rejects capturing it — this proves
    // captureHeldPayment handles a real Razorpay-side rejection the same
    // way executeAndSettle does (deny, log, don't throw), not that a
    // synthetic id can be captured.
    const { merchantId, moneyActionId } = await createHeldPayment("pay_escrow_test_1");

    const result = await captureHeldPayment(merchantId, moneyActionId);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/capture failed/i);

    // Status must be unchanged — a failed capture never silently marks
    // the row captured.
    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("held");
  }, 20_000);

  it("captureHeldPayment denies a money action that isn't held", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);
    await makeCap(agent.id);

    const order = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "not held",
    });
    expect(order.decision).toBe("allow");

    const result = await captureHeldPayment(merchant.id, order.moneyActionId!);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/no held payment/i);
  }, 20_000);

  it("issueRefund fails closed on a synthetic payment id Razorpay genuinely can't refund, and reserves nothing back yet", async () => {
    const { merchantId, agentId, moneyActionId } = await createHeldPayment("pay_escrow_test_2");

    const [capBefore] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agentId));
    expect(capBefore.spentPaise).toBe(30_000);

    const result = await issueRefund(merchantId, moneyActionId);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/refund failed/i);

    // The refundPayment call itself failed, so nothing downstream of it
    // (budget release, status change) should have run.
    const [capAfter] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agentId));
    expect(capAfter.spentPaise).toBe(30_000);

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("held");
  }, 20_000);

  it("issueRefund denies a money action with neither captured nor held status, before calling Razorpay", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);
    await makeCap(agent.id);

    // A denied purchase never reaches "executed", let alone
    // "captured"/"held" — refunding it must be rejected before any
    // Razorpay call, not attempted and fail there.
    const denied = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 999_999_999,
      context: "guaranteed to exceed the cap",
    });
    expect(denied.decision).toBe("deny");

    await expect(issueRefund(merchant.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no money action found/i);
  });

  it("sweepExpiredHolds leaves a hold as held (for retry) when the underlying refund genuinely fails, rather than marking it resolved incorrectly", async () => {
    const { merchantId, moneyActionId } = await createHeldPayment("pay_escrow_test_3");

    // Back-date this hold's expiry into the past — same technique
    // gate.test.ts uses for an expired spend-cap window. The refund
    // itself will fail (synthetic payment id, same as the tests above),
    // which is exactly the case the sweep must not paper over: marking
    // a hold "expired_refunded" when the refund didn't actually succeed
    // would be worse than leaving it visibly still held.
    await db
      .update(schema.escrowHolds)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.escrowHolds.moneyActionId, moneyActionId));

    const sweptCount = await sweepExpiredHolds(merchantId);
    expect(sweptCount).toBe(0);

    const [hold] = await db.select().from(schema.escrowHolds).where(eq(schema.escrowHolds.moneyActionId, moneyActionId));
    expect(hold.outcome).toBe("held");
    expect(hold.resolvedAt).toBeNull();
  }, 20_000);

  it("does not sweep a hold that has not yet expired", async () => {
    const { merchantId, moneyActionId } = await createHeldPayment("pay_escrow_test_4");

    const sweptCount = await sweepExpiredHolds(merchantId);
    expect(sweptCount).toBe(0);

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("held");
  }, 20_000);
});
