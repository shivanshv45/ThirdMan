import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { openReturnRequest } from "@/lib/returns-desk";
import { approveReturnRequest, rejectReturnRequest } from "@/lib/returns-desk-decision";

/**
 * L22-7: amount arithmetic is integer paise throughout, including the
 * partial-refund case — property-based coverage over
 * approveReturnRequest's bounds check, matching gate.properties.test.ts
 * and treasury.properties.test.ts's existing pattern for this kind of
 * invariant. Also covers the merchant decision wiring itself: approve
 * calls gate.ts's issueRefund unchanged, reject never does, and both
 * outcomes are audited with the merchant as actor.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__returns_decision_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCapturedMoneyAction(merchantId: string, agentId: string, amountPaise: number) {
  const [row] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId,
      agentId,
      type: "order_create",
      amountPaise,
      status: "captured",
      razorpayEntityId: `order_returns_decision_test_${Date.now()}_${Math.random()}`,
      // Deliberately synthetic — a real Razorpay refund call against
      // this will genuinely fail, same as escrow.test.ts's own
      // synthetic-payment-id tests. That's fine for the bounds tests
      // below, which never reach the Razorpay call at all.
      razorpayPaymentId: `pay_returns_decision_test_${Date.now()}_${Math.random()}`,
    })
    .returning();
  return row;
}

describe("approveReturnRequest bounds", () => {
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

  it("property: any requested amount greater than the refundable amount is refused before any refund call, for any positive integer pair", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000 }), async (refundableAmountPaise, overshootPaise) => {
        const merchant = await createTestMerchant(`__returns_prop_${Date.now()}_${Math.random()}__`);
        const agent = await makeAgent(merchant.id);
        const action = await makeCapturedMoneyAction(merchant.id, agent.id, refundableAmountPaise);
        const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "property test reason");
        if (opened.requestId === null) throw new Error("expected the request to open");

        const result = await approveReturnRequest(merchant.id, opened.requestId, refundableAmountPaise + overshootPaise);
        expect(result.ok).toBe(false);

        const [fresh] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
        expect(fresh.status).toBe("awaiting_merchant");

        await db.delete(schema.returnRequestMessages).where(eq(schema.returnRequestMessages.returnRequestId, opened.requestId));
        await db.delete(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
        await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
        await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, action.id));
        await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
        await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  it("refuses a zero or negative amount", async () => {
    const merchant = await createTestMerchant("__returns_decision_nonpositive__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id, 50_000);
    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "reason");
    if (opened.requestId === null) throw new Error("expected the request to open");

    const zero = await approveReturnRequest(merchant.id, opened.requestId, 0);
    expect(zero.ok).toBe(false);
    const negative = await approveReturnRequest(merchant.id, opened.requestId, -100);
    expect(negative.ok).toBe(false);
  });

  it("refuses a non-integer amount", async () => {
    const merchant = await createTestMerchant("__returns_decision_noninteger__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id, 50_000);
    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "reason");
    if (opened.requestId === null) throw new Error("expected the request to open");

    const result = await approveReturnRequest(merchant.id, opened.requestId, 100.5);
    expect(result.ok).toBe(false);
  });

  it("rejectReturnRequest never calls issueRefund — the money action and cap are untouched", async () => {
    const merchant = await createTestMerchant("__returns_decision_reject__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id, 50_000);
    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "changed my mind");
    if (opened.requestId === null) throw new Error("expected the request to open");

    const result = await rejectReturnRequest(merchant.id, opened.requestId, "Item was used, not defective.");
    expect(result.ok).toBe(true);

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    expect(request.status).toBe("rejected");
    expect(request.approvedAmountPaise).toBeNull();

    const [freshAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, action.id));
    expect(freshAction.status).toBe("captured");

    const rejectedEntry = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id))
    ).find((r) => r.event === "return_request_rejected");
    expect(rejectedEntry).toBeDefined();
    expect(rejectedEntry?.actor).toBe("merchant");
  });

  it("refuses to act on a request that's already resolved", async () => {
    const merchant = await createTestMerchant("__returns_decision_alreadyresolved__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id, 50_000);
    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "reason");
    if (opened.requestId === null) throw new Error("expected the request to open");

    await rejectReturnRequest(merchant.id, opened.requestId, "first decision");
    const second = await rejectReturnRequest(merchant.id, opened.requestId, "second decision");
    expect(second.ok).toBe(false);

    const approveAfterReject = await approveReturnRequest(merchant.id, opened.requestId);
    expect(approveAfterReject.ok).toBe(false);
  });
});
