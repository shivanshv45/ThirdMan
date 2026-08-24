import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, resolveEscalation } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * No mocks. These exercise the risk layer through the real gate, with
 * real Groq calls deciding escalate vs allow, and real Razorpay orders
 * for approved escalations.
 *
 * Cleanup is scoped to this test's own agent ids, since vitest runs
 * separate test files concurrently by default and an unscoped delete
 * would wipe another file's in-flight rows.
 */

async function makeMerchant() {
  // Real Razorpay test-mode credentials required — checkBounds denies
  // any merchant with none connected (Layer 2-2), and this file's
  // "approve" path executes a real order.
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__escalation_test_${Date.now()}_${Math.random()}__`,
      email: `escalation_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string, track: (agentId: string) => void) {
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: "__escalation_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  track(agent.id);
  return agent;
}

async function makeCap(agentId: string, capPaise: number) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise,
      spentPaise: 0,
      perTransactionMaxPaise: capPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();
  return cap;
}

describe("risk escalation, end to end through the real gate", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    merchantId = undefined;
    agentIds = [];

    if (currentAgentIds.length > 0) {
      await db
        .delete(schema.escalations)
        .where(
          inArray(
            schema.escalations.spendCapId,
            db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds)),
          ),
        );
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    // audit_log rows reference money_actions and now also carry their own
    // merchant_id directly, so delete by merchant_id rather than only via the join.
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  const track = (agentId: string) => agentIds.push(agentId);

  it("escalates a request consuming nearly the whole cap, holding the reservation", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    const cap = await makeCap(agent.id, 100_000);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 98_000, // 98% of the cap in one shot
      context: "espresso machine, an unusually large single purchase against this agent's cap",
    });

    expect(result.decision).toBe("escalate");
    expect(result.moneyActionId).toBeDefined();

    const [moneyAction] = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(moneyAction.status).toBe("pending_escalation");

    // Budget must already be reserved, held pending review.
    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(98_000);

    const [escalation] = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.moneyActionId, result.moneyActionId!));
    expect(escalation).toBeDefined();
    expect(escalation.outcome).toBe("pending");
  }, 30_000);

  it("approving an escalation executes it and creates a real order", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    const cap = await makeCap(agent.id, 100_000);

    const attempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 97_000,
      context: "large espresso machine order, high fraction of cap, should escalate",
    });
    expect(attempt.decision).toBe("escalate");

    const [escalation] = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.moneyActionId, attempt.moneyActionId!));

    const resolved = await resolveEscalation(merchantId, escalation.id, "approved");

    expect(resolved.decision).toBe("allow");
    expect(resolved.razorpayOrderId).toMatch(/^order_/);

    const [moneyAction] = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.id, attempt.moneyActionId!));
    expect(moneyAction.status).toBe("executed");

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(97_000); // unchanged: reserved, then committed, not double-charged

    const [updatedEscalation] = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id));
    expect(updatedEscalation.outcome).toBe("approved");
  }, 30_000);

  it("rejecting an escalation releases the reserved budget without calling Razorpay", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    const cap = await makeCap(agent.id, 100_000);

    const attempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 96_000,
      context: "large purchase that should escalate",
    });
    expect(attempt.decision).toBe("escalate");

    const [escalation] = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.moneyActionId, attempt.moneyActionId!));

    const resolved = await resolveEscalation(merchantId, escalation.id, "rejected");

    expect(resolved.decision).toBe("deny");
    expect(resolved.razorpayOrderId).toBeUndefined();

    const [moneyAction] = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.id, attempt.moneyActionId!));
    expect(moneyAction.status).toBe("failed");

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(0); // released back
  }, 30_000);

  it("cannot resolve the same escalation twice", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    await makeCap(agent.id, 100_000);

    const attempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 95_000,
      context: "large purchase that should escalate",
    });
    expect(attempt.decision).toBe("escalate");

    const [escalation] = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.moneyActionId, attempt.moneyActionId!));

    await resolveEscalation(merchantId, escalation.id, "rejected");

    await expect(resolveEscalation(merchantId, escalation.id, "approved")).rejects.toThrow(/already resolved/);
  }, 30_000);

  it("allows an unremarkable purchase without escalating", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    await makeCap(agent.id, 1_000_000); // large cap

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 20_000, // 2% of the cap, unremarkable
      context: "one bag of coffee, an ordinary small purchase",
    });

    expect(result.decision).toBe("allow");
    expect(result.razorpayOrderId).toMatch(/^order_/);
  }, 30_000);
});
