import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { evaluateGuardianSignals, evaluateAndTransition, rearmAgent, getGuardianState, type GuardianSignals } from "@/lib/guardian";
import { attemptMoneyAction } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 13-4: the Runtime Guardian. evaluateGuardianSignals is pure and
 * tested directly at every threshold boundary; the rest exercises the
 * real DB and the real gate — a suspended agent must be denied by
 * checkBounds itself, not merely flagged.
 */

function baseSignals(overrides: Partial<GuardianSignals> = {}): GuardianSignals {
  return {
    recentTransactionCount: 0,
    velocityBaseline: 0,
    deniedRatio: 0,
    deniedSampleSize: 0,
    maxRetrySameTarget: 0,
    escalationRate: 0,
    escalationSampleSize: 0,
    recentAiCreditRedemptions: 0,
    aiSpendBaseline: 0,
    ...overrides,
  };
}

describe("evaluateGuardianSignals — pure threshold logic", () => {
  it("a quiet agent with no signals breaches nothing", () => {
    const result = evaluateGuardianSignals(baseSignals());
    expect(result.breached).toBe(false);
  });

  it("trips on transaction velocity when it exceeds the multiplier of its own baseline", () => {
    const result = evaluateGuardianSignals(baseSignals({ recentTransactionCount: 25, velocityBaseline: 2 }));
    expect(result.breached).toBe(true);
    expect(result.signal).toBe("transaction_velocity");
  });

  it("does not trip on velocity below the absolute floor even with zero baseline (a brand-new agent's first burst)", () => {
    const result = evaluateGuardianSignals(baseSignals({ recentTransactionCount: 15, velocityBaseline: 0 }));
    expect(result.breached).toBe(false);
  });

  it("trips on denied ratio only once the minimum sample size is met", () => {
    const belowSample = evaluateGuardianSignals(baseSignals({ deniedRatio: 0.9, deniedSampleSize: 3 }));
    expect(belowSample.breached).toBe(false);

    const atSample = evaluateGuardianSignals(baseSignals({ deniedRatio: 0.9, deniedSampleSize: 5 }));
    expect(atSample.breached).toBe(true);
    expect(atSample.signal).toBe("denied_ratio");
  });

  it("trips on retry-same-target above the fixed threshold", () => {
    const result = evaluateGuardianSignals(baseSignals({ maxRetrySameTarget: 6 }));
    expect(result.breached).toBe(true);
    expect(result.signal).toBe("retry_count");
  });

  it("trips on escalation rate only once the minimum sample size is met", () => {
    const belowSample = evaluateGuardianSignals(baseSignals({ escalationRate: 1, escalationSampleSize: 2 }));
    expect(belowSample.breached).toBe(false);

    const atSample = evaluateGuardianSignals(baseSignals({ escalationRate: 0.75, escalationSampleSize: 4 }));
    expect(atSample.breached).toBe(true);
    expect(atSample.signal).toBe("escalation_rate");
  });

  it("trips on AI spend rate when it exceeds the multiplier of its own baseline", () => {
    const result = evaluateGuardianSignals(baseSignals({ recentAiCreditRedemptions: 25, aiSpendBaseline: 2 }));
    expect(result.breached).toBe(true);
    expect(result.signal).toBe("ai_spend_rate");
  });

  it("returns the FIRST breach in the documented priority order, not all of them", () => {
    const result = evaluateGuardianSignals(
      baseSignals({
        recentTransactionCount: 25,
        velocityBaseline: 2, // velocity breaches
        deniedRatio: 0.9,
        deniedSampleSize: 10, // denied ratio would also breach
      }),
    );
    expect(result.signal).toBe("transaction_velocity");
  });
});

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__guardian_test_${Date.now()}_${Math.random()}__`,
      email: `guardian_test_${Date.now()}_${Math.random()}@test.invalid`,
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
    .values({
      merchantId,
      name: "__guardian_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

async function makeCap(agentId: string) {
  const now = new Date();
  await db.insert(schema.spendCaps).values({
    agentId,
    capPaise: 100_000_000,
    spentPaise: 0,
    perTransactionMaxPaise: 100_000_000,
    windowStart: now,
    windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    status: "active",
  });
}

describe("Guardian — real DB, real gate integration", () => {
  let merchantId: string | undefined;
  let agentId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentId = agentId;
    merchantId = undefined;
    agentId = undefined;

    if (currentAgentId) {
      await db.delete(schema.guardianTransitions).where(eq(schema.guardianTransitions.agentId, currentAgentId));
      await db.delete(schema.agentGuardianState).where(eq(schema.agentGuardianState.agentId, currentAgentId));
      await db.delete(schema.escalations).where(eq(schema.escalations.spendCapId, db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(eq(schema.spendCaps.agentId, currentAgentId))));
      await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, currentAgentId));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("a fresh agent with no history starts, and stays, in the normal state", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    expect(await getGuardianState(agent.id)).toBe("normal");
    const result = await evaluateAndTransition(agent.id);
    expect(result.state).toBe("normal");
    expect(result.transitioned).toBe(false);
  });

  it("a real retry-loop pattern trips the breaker, suspending the agent, and checkBounds then denies purchases outright", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;
    await makeCap(agent.id);

    // Real money_actions rows sharing the same (amountPaise, variantId)
    // pair — a genuine retry-loop signature, not a mock.
    for (let i = 0; i < 7; i++) {
      await db.insert(schema.moneyActions).values({
        merchantId,
        agentId: agent.id,
        amountPaise: 5000,
        quantity: 1,
        type: "order_create",
        status: "denied",
      });
    }

    const first = await evaluateAndTransition(agent.id);
    expect(first.transitioned).toBe(true);
    expect(first.state).toBe("throttled");
    expect(first.evaluation.signal).toBe("retry_count");

    // A second breach advances throttled -> suspended.
    const second = await evaluateAndTransition(agent.id);
    expect(second.transitioned).toBe(true);
    expect(second.state).toBe("suspended");

    const [transitions] = [await db.select().from(schema.guardianTransitions).where(eq(schema.guardianTransitions.agentId, agent.id))];
    expect(transitions.length).toBe(2);

    // The real gate must now deny, at the guardian_state bound, before
    // budget is ever reserved.
    const purchaseAttempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 1000,
      context: "should be denied by the Guardian",
    });
    expect(purchaseAttempt.decision).toBe("deny");
    expect(purchaseAttempt.reason).toMatch(/suspended/i);

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    expect(cap.spentPaise).toBe(0);
  }, 30_000);

  it("rearmAgent resets a suspended agent back to normal, and the gate allows again", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;
    await makeCap(agent.id);

    for (let i = 0; i < 7; i++) {
      await db.insert(schema.moneyActions).values({
        merchantId,
        agentId: agent.id,
        amountPaise: 5000,
        quantity: 1,
        type: "order_create",
        status: "denied",
      });
    }
    await evaluateAndTransition(agent.id);
    await evaluateAndTransition(agent.id);
    expect(await getGuardianState(agent.id)).toBe("suspended");

    await rearmAgent(merchantId, agent.id);
    expect(await getGuardianState(agent.id)).toBe("normal");

    const purchaseAttempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 20_000,
      context: "one bag of coffee, ordinary purchase after re-arm",
    });
    expect(purchaseAttempt.decision).not.toBe("deny");
  }, 30_000);

  it("rearmAgent refuses to act on another merchant's agent by id", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const merchantB = await makeMerchant();
    try {
      await expect(rearmAgent(merchantB.id, agent.id)).rejects.toThrow(/not found/i);
    } finally {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    }
  });
});
