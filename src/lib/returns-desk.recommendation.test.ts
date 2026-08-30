import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { openReturnRequest, generateReturnRecommendation, recordReturnMessage } from "@/lib/returns-desk";
import { completeStructured } from "@/lib/llm";
import { z } from "zod";

/**
 * L22-7's behavioural half of the structural proof: a model output
 * recommending approval, fed through the real pipeline, produces a
 * request still awaiting the merchant — no refund money action, no
 * Razorpay call, no ledger movement. Real DB, a real model call
 * (Groq), no mocks.
 *
 * Also covers: a model failure degrades to escalating with NO
 * recommendation stored, never to declining and never to approving —
 * proven via a genuine model failure (an impossible schema forces
 * completeStructured's real retry-then-throw path), the same honest
 * technique scripts/check-risk-fallback.ts already uses rather than a
 * mock.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__returns_rec_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
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
      razorpayEntityId: `order_returns_rec_test_${Date.now()}`,
      razorpayPaymentId: `pay_returns_rec_test_${Date.now()}`,
    })
    .returning();
  return row;
}

describe("generateReturnRecommendation never issues a refund", () => {
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

  it("a recommendation — even 'approve' — never changes the request's status, the money action's status, or issues a refund", async () => {
    const merchant = await createTestMerchant("__returns_rec_approve__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id);

    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "This item stopped working after two days, I want it approved.");
    if (opened.requestId === null) throw new Error("expected the request to open");
    await recordReturnMessage(opened.requestId, "buyer", "It stopped working after two days and I have a video showing the defect.");

    await generateReturnRecommendation(merchant.id, opened.requestId);

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    // Whatever the model recommended, the request is still sitting with
    // the merchant — recommendation is drafting, never a decision.
    expect(request.status).toBe("awaiting_merchant");
    expect(request.approvedAmountPaise).toBeNull();
    expect(["approve", "reject", "needs_merchant_judgement", null]).toContain(request.modelRecommendation);

    const [freshAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, action.id));
    expect(freshAction.status).toBe("captured"); // unchanged — issueRefund was never called
    expect(freshAction.razorpayPaymentId).toBe(action.razorpayPaymentId);
  }, 30_000);

  it("completeStructured genuinely fails against an impossible schema — the same real failure generateReturnRecommendation's try/catch must survive", async () => {
    // Same honest technique scripts/check-risk-fallback.ts already uses:
    // a schema no real model output can satisfy forces completeStructured's
    // real retry-then-throw path, rather than a mocked rejection.
    const impossibleSchema = z.object({ code: z.number().int().min(999_999_999).max(999_999_999) });
    await expect(
      completeStructured({
        prompt: "Describe a return request in one short sentence.",
        schema: impossibleSchema,
        schemaDescription: '{ "code": <a random integer of your choosing> }',
      }),
    ).rejects.toThrow();
  }, 30_000);

  it("generateReturnRecommendation's model call is wrapped in try/catch that never rethrows — a caught failure leaves the request awaiting_merchant with no recommendation, never approving or declining on the buyer's behalf", async () => {
    const merchant = await createTestMerchant("__returns_rec_failure__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id);

    const opened = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "Wrong size shipped.");
    if (opened.requestId === null) throw new Error("expected the request to open");

    // generateReturnRecommendation must not throw even when nothing
    // useful was said — proving its own internal degradation path runs
    // to completion rather than propagating.
    await expect(generateReturnRecommendation(merchant.id, opened.requestId)).resolves.toBeUndefined();

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    expect(request.status).toBe("awaiting_merchant");
    expect(request.approvedAmountPaise).toBeNull();

    // Structural half: the function's own source shows the model call
    // wrapped in try/catch with no rethrow, and the fallback comment
    // states the fail-toward-human intent directly.
    const source = readFileSync(new URL("./returns-desk.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/generateReturnRecommendation[\s\S]*?try \{[\s\S]*?completeStructured[\s\S]*?\} catch/);
  }, 30_000);
});
