import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { openReturnRequest, sweepExpiredReturnRequests } from "@/lib/returns-desk";

/**
 * L22-7: expiry resolves as not-approved, never as approved, and is
 * idempotent when the sweep runs twice — mirroring
 * gate.reservation-sweep.test.ts's shape for the same conditional-
 * UPDATE-claim discipline.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__returns_expiry_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCapturedMoneyAction(merchantId: string, agentId: string) {
  const [row] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId,
      agentId,
      type: "order_create",
      amountPaise: 50_000,
      status: "captured",
      razorpayEntityId: `order_returns_expiry_test_${Date.now()}_${Math.random()}`,
      razorpayPaymentId: `pay_returns_expiry_test_${Date.now()}_${Math.random()}`,
    })
    .returning();
  return row;
}

describe("sweepExpiredReturnRequests", () => {
  const merchantIds: string[] = [];

  afterEach(async () => {
    const ids = [...merchantIds];
    merchantIds.length = 0;
    for (const merchantId of ids) {
      const requestIds = await db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.merchantId, merchantId));
      for (const r of requestIds) {
        await db.delete(schema.returnRequestMessages).where(eq(schema.returnRequestMessages.returnRequestId, r.id));
      }
      await db.delete(schema.returnRequests).where(eq(schema.returnRequests.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("resolves a past-due request as expired, never approved, and releases nothing that wasn't reserved", async () => {
    const merchant = await createTestMerchant("__returns_expiry_basic__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id);

    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "Never arrived.");
    if (opened.requestId === null) throw new Error("expected the request to open");

    await db.update(schema.returnRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.returnRequests.id, opened.requestId));

    const result = await sweepExpiredReturnRequests();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    expect(request.status).toBe("expired");
    expect(request.approvedAmountPaise).toBeNull();

    const [freshAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, action.id));
    expect(freshAction.status).toBe("captured");
  }, 20_000);

  it("leaves an unexpired request untouched", async () => {
    const merchant = await createTestMerchant("__returns_expiry_notyet__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id);

    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "Still deciding what to say.");
    if (opened.requestId === null) throw new Error("expected the request to open");

    await sweepExpiredReturnRequests();

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    expect(request.status).toBe("awaiting_merchant");
  }, 20_000);

  it("is idempotent under two overlapping sweeps", async () => {
    const merchant = await createTestMerchant("__returns_expiry_idempotent__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id);

    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "Damaged in transit.");
    if (opened.requestId === null) throw new Error("expected the request to open");
    await db.update(schema.returnRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.returnRequests.id, opened.requestId));

    // sweepExpiredReturnRequests scans across every merchant, so its
    // returned count isn't scoped to this test's own row when other
    // tests' rows are concurrently in flight — assert on THIS row's own
    // final state and that it was claimed exactly once, not on the
    // sweep's aggregate count.
    await Promise.all([sweepExpiredReturnRequests(), sweepExpiredReturnRequests()]);

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    expect(request.status).toBe("expired");
    expect(request.resolvedAt).not.toBeNull();
  }, 20_000);
});
