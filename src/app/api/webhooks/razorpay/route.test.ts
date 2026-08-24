import { describe, it, expect, afterEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { attemptMoneyAction } from "@/lib/gate";
import { POST } from "./route";

/**
 * L4-8: webhook idempotency and the payment.captured/order.paid handling
 * added in Layer 4-2. A real money_actions row is created via the real
 * gate (same as gate.test.ts) so the webhook has a real order id to
 * resolve against; the webhook payload itself is a synthetic but
 * correctly-signed body, since triggering a genuine Razorpay-sent
 * webhook isn't something a test can drive.
 */

function signedRequest(body: object, eventId: string) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
  return new NextRequest("http://localhost/api/webhooks/razorpay", {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId },
    body: raw,
  });
}

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__webhook_route_test_${Date.now()}_${Math.random()}__`,
      email: `webhook_route_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

describe("POST /api/webhooks/razorpay", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  let eventIds: string[] = [];

  afterEach(async () => {
    if (eventIds.length > 0) {
      await db.delete(schema.webhookEvents).where(inArray(schema.webhookEvents.razorpayEventId, eventIds));
      eventIds = [];
    }
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    merchantId = undefined;
    agentIds = [];

    if (currentAgentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function createRealOrder() {
    const merchant = await makeMerchant();
    merchantId = merchant.id;

    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__webhook_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
      .returning();
    agentIds.push(agent.id);

    const now = new Date();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 1_000_000,
      spentPaise: 0,
      perTransactionMaxPaise: 1_000_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "webhook test order",
    });
    expect(result.decision).toBe("allow");
    return { merchantId: merchant.id, moneyActionId: result.moneyActionId!, orderId: result.razorpayOrderId! };
  }

  it("rejects a bad signature, 400, writes nothing", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "0".repeat(64) },
      body: JSON.stringify({ event: "payment.captured" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("payment.captured confirms the money action as captured", async () => {
    const { moneyActionId, orderId } = await createRealOrder();
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);

    const payload = { event: "payment.captured", payload: { payment: { entity: { id: "pay_webhook_test_1", order_id: orderId } } } };
    const res = await POST(signedRequest(payload, eventId));
    expect(res.status).toBe(200);

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("captured");
    expect(action.razorpayPaymentId).toBe("pay_webhook_test_1");
  }, 20_000);

  it("a redelivered event (same x-razorpay-event-id) is a no-op the second time, not a duplicate capture", async () => {
    const { moneyActionId, orderId } = await createRealOrder();
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);

    const payload = { event: "payment.captured", payload: { payment: { entity: { id: "pay_webhook_test_2", order_id: orderId } } } };

    const first = await POST(signedRequest(payload, eventId));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.duplicate).toBeUndefined();

    const second = await POST(signedRequest(payload, eventId));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.duplicate).toBe(true);

    // Only one webhook_events row for this event id, and the money
    // action's captured status is unchanged by the redelivery.
    const events = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.razorpayEventId, eventId));
    expect(events.length).toBe(1);

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyActionId));
    expect(action.status).toBe("captured");
    expect(action.razorpayPaymentId).toBe("pay_webhook_test_2");
  }, 20_000);

  it("acknowledges an unrelated event type with 200 and does nothing", async () => {
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);
    const res = await POST(signedRequest({ event: "refund.processed" }, eventId));
    expect(res.status).toBe(200);
  });
});
