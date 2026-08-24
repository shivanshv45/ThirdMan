import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";

/**
 * No mocks. Real Razorpay orders, real concurrent requests via
 * Promise.all against the real database — this is what caught the
 * drizzle .cause error-wrapping bug documented in FAILURES.md.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__idempotency_test_${Date.now()}_${Math.random()}__`,
      email: `idempotency_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string, track: (agentId: string) => void) {
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: "__idempotency_test_agent__",
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

describe("attemptMoneyAction idempotency", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  const track = (agentId: string) => agentIds.push(agentId);

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
    await db
      .delete(schema.auditLog)
      .where(
        inArray(
          schema.auditLog.moneyActionId,
          db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId)),
        ),
      );
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("a sequential repeat with the same idempotency key returns the original outcome, not a new charge", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    const cap = await makeCap(agent.id, 200_000);

    const first = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 40_000,
      context: "an ordinary purchase",
      idempotencyKey: "seq-test-key",
    });
    expect(first.decision).toBe("allow");

    const second = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 40_000,
      context: "an ordinary purchase",
      idempotencyKey: "seq-test-key",
    });

    expect(second.moneyActionId).toBe(first.moneyActionId);
    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(40_000); // charged once, not twice
  }, 30_000);

  it("two genuinely concurrent requests with the same idempotency key produce exactly one charge", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    const cap = await makeCap(agent.id, 200_000);

    const [resultA, resultB] = await Promise.all([
      attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 25_000,
        context: "concurrent idempotent request A",
        idempotencyKey: "concurrent-test-key",
      }),
      attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 25_000,
        context: "concurrent idempotent request B",
        idempotencyKey: "concurrent-test-key",
      }),
    ]);

    // Both must resolve to the same underlying money action, whichever won the race.
    expect(resultA.moneyActionId).toBe(resultB.moneyActionId);
    expect(resultA.decision).toBe(resultB.decision);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    // Only one reservation should have stuck, regardless of which request
    // "won" the insert — the loser must have released its own reservation.
    expect(updatedCap.spentPaise).toBe(25_000);

    const allActions = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.agentId, agent.id));
    expect(allActions).toHaveLength(1);
  }, 30_000);

  it("a different idempotency key is treated as a separate purchase", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, track);
    const cap = await makeCap(agent.id, 200_000);

    const first = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 20_000,
      context: "first purchase",
      idempotencyKey: "key-one",
    });
    const second = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 20_000,
      context: "second purchase, different key",
      idempotencyKey: "key-two",
    });

    expect(first.moneyActionId).not.toBe(second.moneyActionId);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(40_000); // both charged
  }, 30_000);
});
