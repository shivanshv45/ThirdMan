import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueRewardCoinsForCapture, redeemRewardCoins, getRewardBalance } from "@/lib/reward-actions";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 6-5: reward coins issue and redeem through the same gate as any
 * other money action, bounded by real balances and merchant-set
 * ceilings, never a model. No mocks — real DB, matching every other
 * gate-adjacent test in this codebase.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__reward_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string, opts: Partial<typeof schema.spendCaps.$inferInsert> = {}) {
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
      ...opts,
    })
    .returning();
  return cap;
}

async function makeRewardSettings(merchantId: string, opts: Partial<typeof schema.merchantRewardSettings.$inferInsert> = {}) {
  const [settings] = await db
    .insert(schema.merchantRewardSettings)
    .values({ merchantId, paisePerCoin: 10, issueRatePermille: 100, maxRedemptionPercent: 50, ...opts })
    .returning();
  return settings;
}

describe("reward coins — issue and redeem through the gate", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    merchantId = undefined;
    agentIds = [];

    if (currentAgentIds.length > 0) {
      const capRows = await db
        .select({ id: schema.spendCaps.id })
        .from(schema.spendCaps)
        .where(inArray(schema.spendCaps.agentId, currentAgentIds));
      const capIds = capRows.map((c) => c.id);
      if (capIds.length > 0) {
        await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, capIds));
      }
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchantRewardSettings).where(eq(schema.merchantRewardSettings.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function setup() {
    const merchant = await createTestMerchant("__reward_test_merchant__", { withRazorpayCredentials: true });
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id);
    return { merchantId, agent };
  }

  it("issuing coins with no reward settings is a silent no-op", async () => {
    const { merchantId, agent } = await setup();
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-money-action-id", 100_000, { agentId: agent.id });

    const balance = await getRewardBalance(merchantId, { agentId: agent.id });
    expect(balance.enabled).toBe(false);
    expect(balance.balance).toBe(0);
  });

  it("issuing coins on a real capture writes a real, gated money_actions row and ledger entry", async () => {
    const { merchantId, agent } = await setup();
    await makeRewardSettings(merchantId, { paisePerCoin: 10, issueRatePermille: 100 }); // 10% of captured value, 10 paise/coin

    // A real captured purchase of ₹1000 (100,000 paise): 10% = 10,000 paise earned, / 10 paise/coin = 1000 coins.
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-id", 100_000, { agentId: agent.id });

    const balance = await getRewardBalance(merchantId, { agentId: agent.id });
    expect(balance.enabled).toBe(true);
    expect(balance.balance).toBe(1000);

    const [moneyAction] = await db
      .select()
      .from(schema.moneyActions)
      .where(eq(schema.moneyActions.merchantId, merchantId));
    expect(moneyAction.type).toBe("reward_issue");
    expect(moneyAction.status).toBe("executed");

    const [ledgerEntry] = await db.select().from(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.merchantId, merchantId));
    expect(ledgerEntry.coinsDelta).toBe(1000);
    expect(ledgerEntry.reason).toBe("purchase_issue");
    expect(ledgerEntry.moneyActionId).toBe(moneyAction.id);

    const [auditEntry] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    expect(auditEntry.decision).toBe("allow");
    expect(auditEntry.reason).toContain("coins");
  });

  it("issuing coins twice for the same purchase (checkout signature + webhook racing) is idempotent, not double-issued", async () => {
    const { merchantId, agent } = await setup();
    await makeRewardSettings(merchantId, { paisePerCoin: 10, issueRatePermille: 100 });

    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-id-dup", 100_000, { agentId: agent.id });
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-id-dup", 100_000, { agentId: agent.id });

    const balance = await getRewardBalance(merchantId, { agentId: agent.id });
    expect(balance.balance).toBe(1000); // not 2000

    const ledgerRows = await db.select().from(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.merchantId, merchantId));
    expect(ledgerRows.length).toBe(1);
  });

  it("redeeming more coins than the real balance is denied with the exact remaining balance", async () => {
    const { merchantId, agent } = await setup();
    await makeRewardSettings(merchantId, { paisePerCoin: 10, issueRatePermille: 100, maxRedemptionPercent: 100 });
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-for-redeem-1", 100_000, { agentId: agent.id }); // earns 1000 coins

    const result = await redeemRewardCoins(merchantId, agent.id, 50_000, 5000, { agentId: agent.id });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("1000");
  });

  it("redeeming more than the merchant's max-redemption-percent ceiling is denied", async () => {
    const { merchantId, agent } = await setup();
    await makeRewardSettings(merchantId, { paisePerCoin: 10, issueRatePermille: 100, maxRedemptionPercent: 10 });
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-for-redeem-2", 1_000_000, { agentId: agent.id }); // earns 10,000 coins

    // 10% of a 50,000 paise purchase = 5,000 paise = 500 coins max, even though the balance easily covers more.
    const result = await redeemRewardCoins(merchantId, agent.id, 50_000, 600, { agentId: agent.id });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("10%");
  });

  it("a valid redemption succeeds, writes a negative ledger entry, and reduces the balance", async () => {
    const { merchantId, agent } = await setup();
    await makeRewardSettings(merchantId, { paisePerCoin: 10, issueRatePermille: 100, maxRedemptionPercent: 100 });
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-for-redeem-3", 100_000, { agentId: agent.id }); // earns 1000 coins

    const result = await redeemRewardCoins(merchantId, agent.id, 50_000, 200, { agentId: agent.id });
    expect(result.decision).toBe("allow");
    expect(result.coinsRedeemed).toBe(200);
    expect(result.valuePaise).toBe(2000);

    const balance = await getRewardBalance(merchantId, { agentId: agent.id });
    expect(balance.balance).toBe(800);

    const redemptionRow = await db
      .select()
      .from(schema.rewardCoinLedger)
      .where(eq(schema.rewardCoinLedger.merchantId, merchantId));
    const redemption = redemptionRow.find((r) => r.reason === "redemption");
    expect(redemption?.coinsDelta).toBe(-200);
  });

  it("concurrent redemptions against a balance sufficient for exactly one are atomic — exactly one succeeds", async () => {
    const { merchantId, agent } = await setup();
    await makeRewardSettings(merchantId, { paisePerCoin: 10, issueRatePermille: 1000, maxRedemptionPercent: 100 }); // 100% issue rate for a big balance
    await issueRewardCoinsForCapture(merchantId, agent.id, "fake-purchase-for-concurrency", 10_000, { agentId: agent.id }); // earns 1000 coins

    // Two concurrent redemptions of 600 coins each against a balance of 1000 — only one can succeed (600+600 > 1000).
    const [r1, r2] = await Promise.all([
      redeemRewardCoins(merchantId, agent.id, 1_000_000, 600, { agentId: agent.id }),
      redeemRewardCoins(merchantId, agent.id, 1_000_000, 600, { agentId: agent.id }),
    ]);

    const outcomes = [r1.decision, r2.decision];
    expect(outcomes.filter((d) => d === "allow").length).toBe(1);
    expect(outcomes.filter((d) => d === "deny").length).toBe(1);

    const balance = await getRewardBalance(merchantId, { agentId: agent.id });
    expect(balance.balance).toBe(400); // 1000 - 600, never negative
  });
});
