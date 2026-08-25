import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Reward-coin arithmetic (Layer 6-5) — the coin-to-paise conversion, the
 * issuance rate, and the redemption ceiling all live here as pure,
 * integer-only functions. No model is anywhere near this. See CLAUDE.md
 * rule 3 (integer paise, never floats) and rule 2 (code decides limits).
 *
 * Coins are an integer count, never a float. A buyer's balance is the
 * SUM of reward_coin_ledger's signed deltas for their identity, never a
 * mutable column — same reasoning DECISIONS.md gives for recoveredPaise
 * living on the attempt rather than the failure: one number derived
 * from evidence, not two that can diverge.
 */

export interface RewardIdentity {
  agentId?: string;
  sessionToken?: string;
}

export async function getRewardSettings(merchantId: string) {
  const [settings] = await db.select().from(schema.merchantRewardSettings).where(eq(schema.merchantRewardSettings.merchantId, merchantId));
  return settings ?? null;
}

/**
 * Coins issued for a captured purchase of capturedAmountPaise, at the
 * merchant's own issueRatePermille. Floors rather than rounds up — a
 * merchant's coin liability should never exceed what the stated rate
 * actually earns, the same "never round in the buyer's favor beyond
 * what was promised" discipline as any other money computation here.
 */
export function computeCoinsToIssue(capturedAmountPaise: number, settings: { paisePerCoin: number; issueRatePermille: number }): number {
  if (!Number.isInteger(capturedAmountPaise) || capturedAmountPaise <= 0) return 0;
  const earnedValuePaise = Math.floor((capturedAmountPaise * settings.issueRatePermille) / 1000);
  return Math.floor(earnedValuePaise / settings.paisePerCoin);
}

/** The paise value of N coins, at the merchant's own rate. Integer multiplication only. */
export function coinsToValuePaise(coins: number, settings: { paisePerCoin: number }): number {
  return coins * settings.paisePerCoin;
}

/**
 * The most coins a purchase of purchaseAmountPaise may be discounted by,
 * given the merchant's maxRedemptionPercent — a ceiling in coins, not
 * paise, so the caller can compare directly against a real balance.
 * Rounds down: the buyer never gets to redeem fractionally more than
 * the merchant's own stated ceiling allows.
 */
export function maxRedeemableCoinsForPurchase(
  purchaseAmountPaise: number,
  settings: { paisePerCoin: number; maxRedemptionPercent: number },
): number {
  const maxValuePaise = Math.floor((purchaseAmountPaise * settings.maxRedemptionPercent) / 100);
  return Math.floor(maxValuePaise / settings.paisePerCoin);
}

/** Sum of every ledger entry for one identity — the balance, always derived, never stored. */
export async function getCoinBalance(merchantId: string, identity: RewardIdentity): Promise<number> {
  if (!identity.agentId && !identity.sessionToken) return 0;

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.rewardCoinLedger.coinsDelta}), 0)` })
    .from(schema.rewardCoinLedger)
    .where(
      and(
        eq(schema.rewardCoinLedger.merchantId, merchantId),
        identity.agentId ? eq(schema.rewardCoinLedger.agentId, identity.agentId) : eq(schema.rewardCoinLedger.sessionToken, identity.sessionToken!),
      ),
    );

  return Number(row?.total ?? 0);
}
