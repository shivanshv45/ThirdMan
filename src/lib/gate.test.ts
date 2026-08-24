import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";

/**
 * No mocks anywhere in this file. These tests hit the real Neon database
 * and the real Razorpay test-mode API, so every "allow" here creates a
 * genuine test-mode order, and the "execution fails" case provokes a
 * real Razorpay rejection rather than simulating one. Slower than a
 * mocked suite, but the only way to be sure the gate behaves correctly
 * end to end. See FAILURES.md for a bug a mocked suite missed.
 *
 * Cleanup is scoped to each test's own merchant/agent ids. vitest runs
 * separate test files concurrently by default, so an unscoped delete
 * here would wipe rows another file's in-flight test still needs.
 * audit_log rows are left in place: they carry no foreign key anything
 * else depends on, and every read against them is already scoped by
 * event/reason, so stray rows from past runs are harmless noise.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__gate_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `gate_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string, status: "active" | "revoked" = "active") {
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: "__gate_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status,
    })
    .returning();
  return agent;
}

async function makeCap(
  agentId: string,
  opts: Partial<typeof schema.spendCaps.$inferInsert> = {},
) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise: 100_000, // ₹1000
      spentPaise: 0,
      perTransactionMaxPaise: 50_000, // ₹500
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
      ...opts,
    })
    .returning();
  return cap;
}

describe("attemptMoneyAction", () => {
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
    // merchant_id directly (e.g. denials logged before any money_actions
    // row exists), so delete by merchant_id rather than only via the join.
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function setupAgent(status: "active" | "revoked" = "active") {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId, status);
    agentIds.push(agent.id);
    return { merchantId, agent };
  }

  it("denies a revoked agent", async () => {
    const { merchantId, agent } = await setupAgent("revoked");
    await makeCap(agent.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "test purchase",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/revoked/i);
    expect(result.razorpayOrderId).toBeUndefined();
  });

  it("denies when no spend cap exists", async () => {
    const { merchantId, agent } = await setupAgent();

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "test purchase",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/no spend cap/i);
  });

  it("denies when the cap window has expired, and marks it expired", async () => {
    const { merchantId, agent } = await setupAgent();
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const cap = await makeCap(agent.id, {
      windowStart: past,
      windowEnd: new Date(past.getTime() + 1000),
    });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "test purchase",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/lapsed/i);

    const [updated] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updated.status).toBe("expired");
  });

  it("denies a single transaction exceeding the per-transaction max, even with cap room", async () => {
    const { merchantId, agent } = await setupAgent();
    await makeCap(agent.id, { capPaise: 1_000_000, perTransactionMaxPaise: 50_000 });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 60_000, // over the ₹500 per-tx max, well under the ₹10,000 cap
      context: "test purchase",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/per-transaction limit/i);
  });

  it("denies a transaction exceeding the remaining window balance", async () => {
    const { merchantId, agent } = await setupAgent();
    await makeCap(agent.id, { capPaise: 100_000, spentPaise: 95_000, perTransactionMaxPaise: 50_000 });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000, // under per-tx max, but only ₹50 remains in the cap
      context: "test purchase",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/remaining/i);
  });

  it("allows a valid purchase within all bounds, creates a real order, and reserves the budget", async () => {
    const { merchantId, agent } = await setupAgent();
    const cap = await makeCap(agent.id, { capPaise: 100_000, perTransactionMaxPaise: 50_000 });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 20_000,
      context: "one bag of coffee, an ordinary small purchase",
    });

    expect(result.decision).toBe("allow");
    expect(result.moneyActionId).toBeDefined();
    // A real Razorpay test-mode order id, e.g. "order_XXXXXXXXXXXXXX".
    expect(result.razorpayOrderId).toMatch(/^order_/);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(20_000);

    const [action] = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(action.status).toBe("executed");
    expect(action.razorpayEntityId).toBe(result.razorpayOrderId);
  }, 20_000);

  it("releases reserved budget when Razorpay genuinely rejects the order", async () => {
    const { merchantId, agent } = await setupAgent();
    // amountPaise: 1 clears the gate's own bound checks and reservation
    // succeeds, but it's below Razorpay's real minimum order amount, so
    // Razorpay itself rejects it with a genuine BAD_REQUEST_ERROR after
    // the budget has already been reserved.
    const cap = await makeCap(agent.id, { capPaise: 100_000, perTransactionMaxPaise: 50_000 });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 1, // below Razorpay's minimum order amount, a real rejection
      context: "test purchase",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/execution failed/i);
    expect(result.reason).toMatch(/released/i);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    // Budget must be back to 0, the failed execution must not have consumed it.
    expect(updatedCap.spentPaise).toBe(0);

    const [action] = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(action.status).toBe("failed");
  }, 20_000);

  it("allows exactly one of two concurrent requests when only one can fit the remaining budget", async () => {
    const { merchantId, agent } = await setupAgent();
    // A large cap with room for exactly one of two small requests, not
    // both. Each request is a small fraction of the cap (unremarkable to
    // the risk layer) so the race is purely on reserveBudget's atomicity,
    // not on whether the risk model happens to escalate a large spend.
    await makeCap(agent.id, { capPaise: 1_060_000, spentPaise: 1_000_000, perTransactionMaxPaise: 60_000 });

    const [resultA, resultB] = await Promise.all([
      attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 60_000,
        context: "concurrent request A, an ordinary small purchase",
      }),
      attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 60_000,
        context: "concurrent request B, an ordinary small purchase",
      }),
    ]);

    const decisions = [resultA.decision, resultB.decision].sort();
    expect(decisions).toEqual(["allow", "deny"]);

    const allowed = [resultA, resultB].find((r) => r.decision === "allow");
    expect(allowed?.razorpayOrderId).toMatch(/^order_/);
  }, 20_000);

  it("writes an audit entry for every decision, including denials", async () => {
    const { merchantId, agent } = await setupAgent("revoked");
    await makeCap(agent.id);

    await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "audit check",
    });

    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.event, "money_action_attempt:order_create"));

    const found = entries.find((e) => e.reason.includes(agent.name) && e.reason.includes("revoked"));
    expect(found).toBeDefined();
    expect(found?.decision).toBe("deny");
  });
});
