import { describe, it, expect } from "vitest";
import { computeCoinsToIssue, coinsToValuePaise, maxRedeemableCoinsForPurchase } from "@/lib/reward-coins";

/**
 * Layer 6-5: pure integer arithmetic, no DB, no model — the coin
 * conversion, issuance, and redemption-ceiling math CLAUDE.md rule 3
 * requires. Every rounding direction is pinned here so it can never
 * silently drift.
 */

describe("computeCoinsToIssue", () => {
  it("floors rather than rounds up — a merchant's liability never exceeds the stated rate", () => {
    // 5% of 999 paise = 49.95 paise -> floor to 49 paise -> 49/10 = 4.9 -> floor to 4 coins
    const coins = computeCoinsToIssue(999, { paisePerCoin: 10, issueRatePermille: 50 });
    expect(coins).toBe(4);
  });

  it("computes exactly for round numbers", () => {
    // 10% of 10000 paise = 1000 paise, at 10 paise/coin = 100 coins
    const coins = computeCoinsToIssue(10_000, { paisePerCoin: 10, issueRatePermille: 100 });
    expect(coins).toBe(100);
  });

  it("returns 0 for a non-positive or non-integer amount", () => {
    expect(computeCoinsToIssue(0, { paisePerCoin: 10, issueRatePermille: 50 })).toBe(0);
    expect(computeCoinsToIssue(-500, { paisePerCoin: 10, issueRatePermille: 50 })).toBe(0);
    expect(computeCoinsToIssue(100.5, { paisePerCoin: 10, issueRatePermille: 50 })).toBe(0);
  });

  it("returns 0 when the earned value is less than one coin", () => {
    const coins = computeCoinsToIssue(5, { paisePerCoin: 100, issueRatePermille: 10 });
    expect(coins).toBe(0);
  });
});

describe("coinsToValuePaise", () => {
  it("is exact integer multiplication", () => {
    expect(coinsToValuePaise(37, { paisePerCoin: 25 })).toBe(925);
  });

  it("is zero for zero coins", () => {
    expect(coinsToValuePaise(0, { paisePerCoin: 25 })).toBe(0);
  });
});

describe("maxRedeemableCoinsForPurchase", () => {
  it("floors the ceiling — a buyer never redeems fractionally more than the stated percent", () => {
    // 15% of 1099 paise = 164.85 paise -> floor to 164 paise -> 164/10 = 16.4 -> floor to 16 coins
    const maxCoins = maxRedeemableCoinsForPurchase(1099, { paisePerCoin: 10, maxRedemptionPercent: 15 });
    expect(maxCoins).toBe(16);
  });

  it("computes exactly for round numbers", () => {
    // 50% of 10000 paise = 5000 paise, at 100 paise/coin = 50 coins
    const maxCoins = maxRedeemableCoinsForPurchase(10_000, { paisePerCoin: 100, maxRedemptionPercent: 50 });
    expect(maxCoins).toBe(50);
  });

  it("is zero when maxRedemptionPercent is zero", () => {
    const maxCoins = maxRedeemableCoinsForPurchase(10_000, { paisePerCoin: 10, maxRedemptionPercent: 0 });
    expect(maxCoins).toBe(0);
  });
});
