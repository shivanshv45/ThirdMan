import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { checkReturnEligibility, openReturnRequest } from "@/lib/returns-desk";

/**
 * L22-7: every deterministic eligibility check, each against real rows,
 * real DB, no mocks — matching the plan's explicit list: wrong
 * merchant, wrong requester, uncaptured action, expired window, already
 * refunded, duplicate open request.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__returns_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCapturedMoneyAction(merchantId: string, opts: { agentId?: string; cartId?: string; createdAt?: Date; amountPaise?: number } = {}) {
  const [row] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId,
      agentId: opts.agentId,
      cartId: opts.cartId,
      type: "order_create",
      amountPaise: opts.amountPaise ?? 50_000,
      status: "captured",
      razorpayEntityId: `order_returns_test_${Date.now()}_${Math.random()}`,
      razorpayPaymentId: `pay_returns_test_${Date.now()}_${Math.random()}`,
      createdAt: opts.createdAt,
    })
    .returning();
  return row;
}

async function makeConversationWithContact(merchantId: string, email: string) {
  const [contact] = await db.insert(schema.customerContacts).values({ merchantId, address: email, consentSource: "chat_restock_request", unsubscribeToken: `tok_${Date.now()}_${Math.random()}` }).returning();
  const [conversation] = await db.insert(schema.conversations).values({ merchantId, sessionToken: `sess_${Date.now()}_${Math.random()}`, customerContactId: contact.id }).returning();
  const [cartPurchase] = await db.insert(schema.cartPurchases).values({ merchantId, conversationId: conversation.id }).returning();
  return { contact, conversation, cartPurchase };
}

describe("checkReturnEligibility", () => {
  const merchantIds: string[] = [];

  afterEach(async () => {
    const ids = [...merchantIds];
    merchantIds.length = 0;
    for (const merchantId of ids) {
      await db.delete(schema.returnRequestMessages).where(inArray(schema.returnRequestMessages.returnRequestId, db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.merchantId, merchantId))));
      await db.delete(schema.returnRequests).where(eq(schema.returnRequests.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      // money_actions.cartId references cart_purchases — must be deleted
      // before cart_purchases, the same FK-ordering class of miss
      // FAILURES.md already logs repeatedly for this codebase.
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
      await db.delete(schema.cartPurchases).where(eq(schema.cartPurchases.merchantId, merchantId));
      await db.delete(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
      await db.delete(schema.customerContacts).where(eq(schema.customerContacts.merchantId, merchantId));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("denies a fabricated money action id (not_found)", async () => {
    const merchant = await createTestMerchant("__returns_notfound__");
    merchantIds.push(merchant.id);

    const result = await checkReturnEligibility(merchant.id, "00000000-0000-0000-0000-000000000000", { agentId: "00000000-0000-0000-0000-000000000000" });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("not_found");
  });

  it("denies a real money action id belonging to a DIFFERENT merchant (cross-merchant id enumeration)", async () => {
    const merchantA = await createTestMerchant("__returns_crossA__");
    merchantIds.push(merchantA.id);
    const merchantB = await createTestMerchant("__returns_crossB__");
    merchantIds.push(merchantB.id);
    const agentB = await makeAgent(merchantB.id);
    const action = await makeCapturedMoneyAction(merchantB.id, { agentId: agentB.id });

    const result = await checkReturnEligibility(merchantA.id, action.id, { agentId: agentB.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("not_found");
  });

  it("denies an agent requesting a return on a purchase that belongs to a DIFFERENT agent (wrong_requester)", async () => {
    const merchant = await createTestMerchant("__returns_wrongagent__");
    merchantIds.push(merchant.id);
    const agentOwner = await makeAgent(merchant.id);
    const agentImposter = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agentOwner.id });

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agentImposter.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("wrong_requester");
  });

  it("denies a human buyer whose contact doesn't match the purchase's conversation (wrong_requester)", async () => {
    const merchant = await createTestMerchant("__returns_wrongcontact__");
    merchantIds.push(merchant.id);
    const { cartPurchase } = await makeConversationWithContact(merchant.id, "owner@test.invalid");
    const { contact: imposterContact } = await makeConversationWithContact(merchant.id, "imposter@test.invalid");
    const action = await makeCapturedMoneyAction(merchant.id, { cartId: cartPurchase.id });

    const result = await checkReturnEligibility(merchant.id, action.id, { contactId: imposterContact.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("wrong_requester");
  });

  it("denies a money action that was never captured (not_captured)", async () => {
    const merchant = await createTestMerchant("__returns_notcaptured__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const [action] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 50_000, status: "allowed" })
      .returning();

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("not_captured");
  });

  it("denies a request outside the merchant's published return window", async () => {
    const merchant = await createTestMerchant("__returns_window__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    await db.insert(schema.merchantPolicies).values({ merchantId: merchant.id, returnsAccepted: true, returnWindowDays: 7 });
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agent.id, createdAt: oldDate });

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("outside_window");
  });

  it("forwards to the merchant (does not deny) when no return window is published at all", async () => {
    const merchant = await createTestMerchant("__returns_nowindow__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agent.id, createdAt: oldDate });

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(true);
  });

  it("denies a purchase fully refunded elsewhere (money_actions.status transitions to failed) as not_captured — the same fact, checked once", async () => {
    const merchant = await createTestMerchant("__returns_refunded_full__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agent.id });
    // gate.ts's issueRefund transitions a FULLY refunded action's status
    // to "failed" — checkReturnEligibility's not_captured check already
    // denies this; there's no separate "already_refunded" branch for a
    // full refund because it's the same fact under a different name.
    await db.update(schema.moneyActions).set({ status: "failed" }).where(eq(schema.moneyActions.id, action.id));

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("not_captured");
  });

  it("denies a duplicate request once a PARTIAL refund has already been issued through this desk (money_actions.status stays captured)", async () => {
    const merchant = await createTestMerchant("__returns_refunded_partial__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agent.id, amountPaise: 100_000 });

    // Simulates a prior partial refund already resolved through the
    // returns desk — money_actions.status stays "captured" (only a FULL
    // refund transitions it to "failed"), so this is the one case
    // not_captured can't see and the desk's own return_requests row
    // must catch instead.
    await db.insert(schema.returnRequests).values({
      merchantId: merchant.id,
      moneyActionId: action.id,
      requesterAgentId: agent.id,
      statedReason: "prior partial return",
      status: "refunded",
      refundableAmountPaise: 100_000,
      approvedAmountPaise: 40_000,
      expiresAt: new Date(Date.now() + 1000),
      resolvedAt: new Date(),
    });

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("already_refunded");
  });

  it("denies opening a second request while one is already open for the same purchase", async () => {
    const merchant = await createTestMerchant("__returns_duplicate__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agent.id });

    const first = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "It arrived broken.");
    expect(first.status).toBe("awaiting_merchant");

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(false);
    expect(result.failure).toBe("already_open");

    const second = await openReturnRequest(merchant.id, action.id, { agentId: agent.id }, "Trying again.");
    expect(second.status).toBe("refused");
  });

  it("computes the refundable amount from the real money action, never from caller input", async () => {
    const merchant = await createTestMerchant("__returns_amount__");
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, { agentId: agent.id, amountPaise: 123_456 });

    const result = await checkReturnEligibility(merchant.id, action.id, { agentId: agent.id });
    expect(result.eligible).toBe(true);
    expect(result.refundableAmountPaise).toBe(123_456);
  });
});
