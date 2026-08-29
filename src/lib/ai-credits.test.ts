import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { redeemAiCredit, getEnabledTiers } from "@/lib/ai-credits";
import { issueRewardCoinsForCapture, getRewardBalance } from "@/lib/reward-actions";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 11-8: AI credit tiers. No mocks — real Groq calls, same
 * standard as llm.test.ts/risk.ts's own tests. The two assertions that
 * matter most:
 *  1. A refund on model failure returns the balance to EXACTLY its
 *     pre-redemption value — a customer must never pay coins for
 *     nothing, even though no rupees ever moved.
 *  2. providerServed on a successful redemption matches what actually
 *     answered — the honesty claim (real Groq models under real names)
 *     is enforced by a test, not just asserted in a comment.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__ai_credit_test_agent__", apiKeyHash: `ai_credit_test_${Date.now()}_${Math.random()}`, status: "active" })
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

async function makeRewardSettings(merchantId: string) {
  const [settings] = await db.insert(schema.merchantRewardSettings).values({ merchantId, paisePerCoin: 10, issueRatePermille: 100, maxRedemptionPercent: 50 }).returning();
  return settings;
}

async function makeTier(merchantId: string, coinsPerRequest: number) {
  const [tier] = await db
    .insert(schema.aiCreditTiers)
    .values({ merchantId, modelId: "openai/gpt-oss-20b", displayName: "Groq — GPT-OSS 20B (fast)", provider: "groq", coinsPerRequest })
    .returning();
  return tier;
}

let merchantId: string | undefined;
let agentIds: string[] = [];

afterEach(async () => {
  if (!merchantId) return;
  const currentMerchantId = merchantId;
  const currentAgentIds = agentIds;
  merchantId = undefined;
  agentIds = [];

  await db.delete(schema.aiCreditRedemptions).where(eq(schema.aiCreditRedemptions.merchantId, currentMerchantId));
  await db.delete(schema.aiCreditTiers).where(eq(schema.aiCreditTiers.merchantId, currentMerchantId));
  await db.delete(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.merchantId, currentMerchantId));
  await db.delete(schema.merchantRewardSettings).where(eq(schema.merchantRewardSettings.merchantId, currentMerchantId));
  await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
  // The live risk layer (assessRisk, called inside every
  // attemptMoneyAction) can non-deterministically escalate any of
  // these redemptions — escalations FK into money_actions, so must go
  // before it, same lesson every FK-ordering entry in this repo
  // already documents. Scoped by capId, not merchantId directly,
  // since escalations has no merchant_id column of its own.
  if (currentAgentIds.length > 0) {
    const caps = await db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    const capIds = caps.map((c) => c.id);
    if (capIds.length > 0) {
      await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, capIds));
    }
  }
  await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
  if (currentAgentIds.length > 0) {
    await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
  }
  await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
  await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
});

describe("redeemAiCredit", () => {
  it("denies with a clear reason when the balance is insufficient", async () => {
    const merchant = await createTestMerchant("__ai_credit_test_insufficient__");
    merchantId = merchant.id;
    const agent = await makeAgent(merchant.id);
    agentIds = [agent.id];
    await makeCap(agent.id);
    await makeRewardSettings(merchant.id);
    const tier = await makeTier(merchant.id, 50);

    const result = await redeemAiCredit(merchant.id, agent.id, tier.id, { agentId: agent.id }, "hello");

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/only 0 are available/i);
  });

  it("redeems coins for a real response, debits the exact tier price, and providerServed matches what actually answered", async () => {
    const merchant = await createTestMerchant("__ai_credit_test_success__", { withRazorpayCredentials: true });
    merchantId = merchant.id;
    const agent = await makeAgent(merchant.id);
    agentIds = [agent.id];
    await makeCap(agent.id);
    await makeRewardSettings(merchant.id);
    const tier = await makeTier(merchant.id, 20);

    await issueRewardCoinsForCapture(merchant.id, agent.id, randomUUID(), 500_000, { agentId: agent.id });
    const before = await getRewardBalance(merchant.id, { agentId: agent.id });
    expect(before.balance).toBeGreaterThanOrEqual(20);

    const result = await redeemAiCredit(merchant.id, agent.id, tier.id, { agentId: agent.id }, "Say 'test ok' and nothing else.");

    expect(result.decision).toBe("allow");
    expect(result.coinsSpent).toBe(20);
    expect(typeof result.responseText).toBe("string");
    expect(result.responseText!.length).toBeGreaterThan(0);

    const after = await getRewardBalance(merchant.id, { agentId: agent.id });
    expect(after.balance).toBe(before.balance - 20);

    const [redemption] = await db.select().from(schema.aiCreditRedemptions).where(eq(schema.aiCreditRedemptions.tierId, tier.id));
    expect(redemption.succeeded).toBe(true);
    expect(redemption.providerServed).toBe(result.providerServed);
    expect(redemption.coinsSpent).toBe(20);
  }, 30_000);

  it("refunds the exact coins spent when the model call fails after the debit — balance ends exactly where it started", async () => {
    const merchant = await createTestMerchant("__ai_credit_test_refund__", { withRazorpayCredentials: true });
    merchantId = merchant.id;
    const agent = await makeAgent(merchant.id);
    agentIds = [agent.id];
    await makeCap(agent.id);
    await makeRewardSettings(merchant.id);
    // An invalid model id — Groq will reject the call, forcing the
    // refund path deterministically rather than hoping for a flaky
    // real failure.
    const [tier] = await db
      .insert(schema.aiCreditTiers)
      .values({ merchantId: merchant.id, modelId: "not-a-real-groq-model-id", displayName: "Broken tier (test fixture)", provider: "groq", coinsPerRequest: 15 })
      .returning();

    await issueRewardCoinsForCapture(merchant.id, agent.id, randomUUID(), 500_000, { agentId: agent.id });
    const before = await getRewardBalance(merchant.id, { agentId: agent.id });
    expect(before.balance).toBeGreaterThanOrEqual(15);

    const result = await redeemAiCredit(merchant.id, agent.id, tier.id, { agentId: agent.id }, "hello");

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/refund/i);

    const after = await getRewardBalance(merchant.id, { agentId: agent.id });
    expect(after.balance).toBe(before.balance); // exactly restored, not approximately

    const refundEntries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.event, "ai_credit_refunded"));
    expect(refundEntries.some((e) => e.merchantId === merchant.id)).toBe(true);
  }, 30_000);

  it("getEnabledTiers excludes a disabled tier", async () => {
    const merchant = await createTestMerchant("__ai_credit_test_disabled__");
    merchantId = merchant.id;
    await makeRewardSettings(merchant.id);
    const [enabledTier] = await db.insert(schema.aiCreditTiers).values({ merchantId: merchant.id, modelId: "openai/gpt-oss-20b", displayName: "Enabled", provider: "groq", coinsPerRequest: 10 }).returning();
    await db.insert(schema.aiCreditTiers).values({ merchantId: merchant.id, modelId: "openai/gpt-oss-120b", displayName: "Disabled", provider: "groq", coinsPerRequest: 30, enabled: false });

    const tiers = await getEnabledTiers(merchant.id);
    expect(tiers.map((t) => t.id)).toEqual([enabledTier.id]);
  });
});
