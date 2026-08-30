import { attemptMoneyAction } from "@/lib/gate";
import { getRewardSettings, computeCoinsToIssue, coinsToValuePaise, maxRedeemableCoinsForPurchase, getCoinBalance, type RewardIdentity } from "@/lib/reward-coins";
import { resolveRewardMultiplier, buildRuleContext } from "@/lib/reward-rules";

/**
 * Orchestrates the two reward-coin money actions (Layer 6-5) through the
 * gate — issueRewardCoins() and redeemRewardCoins() are the only writers
 * of a reward_coin_ledger row, both via attemptMoneyAction(), same
 * "the gate is the only path to a money action" discipline every other
 * feature layer follows (ARCHITECTURE.md).
 */

/**
 * Issues coins for a just-captured purchase. Callers: confirmCapture's
 * two independent success paths (checkout signature, webhook) — never
 * called on "executed" or "held", only a genuinely captured payment, so
 * a hold that's never released never earns coins (gate contract point
 * 10: executed is not captured). If the merchant hasn't configured
 * reward settings, this is a silent no-op — rewards are opt-in, not a
 * default every merchant gets whether they asked for it or not.
 *
 * Idempotent by the originating purchase's own money_action id: the
 * gate's own idempotencyKey mechanism handles the case where this
 * function is called twice for the same capture (checkout signature and
 * webhook landing within moments of each other, same "fastest signal
 * wins, second is a no-op" contract confirmCapture itself already keeps)
 * — passing the purchase's money_action id as the idempotency key means
 * a second call replays the first issuance's outcome rather than
 * crediting coins twice for one purchase.
 *
 * Layer 14-2: the base coin count is scaled by a merchant-configured
 * reward rule's multiplier, if one matches this purchase's real order
 * value/margin/returning-buyer signals (reward-rules.ts's
 * resolveRewardMultiplier) — margin is computed from costPaise entirely
 * within this call and never surfaces past the multiplier arithmetic
 * itself; the coins credited are the only buyer-visible output.
 */
export async function issueRewardCoinsForCapture(
  merchantId: string,
  agentId: string,
  purchaseMoneyActionId: string,
  capturedAmountPaise: number,
  identity: RewardIdentity,
  variantId: string | null = null,
): Promise<void> {
  const settings = await getRewardSettings(merchantId);
  if (!settings) return;

  const baseCoins = computeCoinsToIssue(capturedAmountPaise, settings);
  if (baseCoins <= 0) return;

  const ctx = await buildRuleContext(merchantId, { id: purchaseMoneyActionId, agentId, amountPaise: capturedAmountPaise, variantId });
  const { multiplierPermille, matchedDescription } = await resolveRewardMultiplier(merchantId, ctx);
  const coins = Math.floor((baseCoins * multiplierPermille) / 1000);
  if (coins <= 0) return;

  const valuePaise = coinsToValuePaise(coins, settings);
  const multiplierNote = matchedDescription ? ` (rule matched: ${matchedDescription})` : "";

  await attemptMoneyAction({
    agentId,
    merchantId,
    type: "reward_issue",
    amountPaise: valuePaise,
    context: `Reward coins issued: ${coins} coins for a ₹${(capturedAmountPaise / 100).toFixed(2)} purchase${multiplierNote}`,
    idempotencyKey: `reward_issue:${purchaseMoneyActionId}`,
    rewardLedger: { coinsDelta: coins, reason: "purchase_issue", identity },
  });
}

export interface RedeemResult {
  decision: "allow" | "deny";
  reason: string;
  coinsRedeemed?: number;
  valuePaise?: number;
}

/**
 * Redeems up to requestedCoins against a purchase of purchaseAmountPaise,
 * bounded by both the buyer's real balance and the merchant's own
 * maxRedemptionPercent ceiling for that purchase. The balance check here
 * is a fast, readable pre-check for the common case (denies with the
 * exact remaining balance in the reason) — the actual atomicity
 * guarantee against a concurrent over-redemption lives in gate.ts's
 * executeAndSettle, which re-derives and re-checks the live balance in
 * the same SQL statement as the ledger insert. This pre-check existing
 * doesn't weaken that: a race that slips past it still gets caught
 * there and denied, same "the gate is the real bound" pattern as
 * checkBounds's own pre-checks before reserveBudget's atomic UPDATE.
 */
export async function redeemRewardCoins(
  merchantId: string,
  agentId: string,
  purchaseAmountPaise: number,
  requestedCoins: number,
  identity: RewardIdentity,
  idempotencyKey?: string,
): Promise<RedeemResult> {
  const settings = await getRewardSettings(merchantId);
  if (!settings) {
    return { decision: "deny", reason: "This merchant has not enabled a rewards program." };
  }

  if (!Number.isInteger(requestedCoins) || requestedCoins <= 0) {
    return { decision: "deny", reason: `Denied — ${requestedCoins} is not a positive integer number of coins.` };
  }

  const balance = await getCoinBalance(merchantId, identity);
  if (requestedCoins > balance) {
    return { decision: "deny", reason: `Denied — requested ${requestedCoins} coins, but only ${balance} are available.` };
  }

  const maxRedeemable = maxRedeemableCoinsForPurchase(purchaseAmountPaise, settings);
  if (requestedCoins > maxRedeemable) {
    return {
      decision: "deny",
      reason: `Denied — ${requestedCoins} coins exceeds the ${settings.maxRedemptionPercent}% max redemption for this purchase (at most ${maxRedeemable} coins here).`,
    };
  }

  const valuePaise = coinsToValuePaise(requestedCoins, settings);

  const result = await attemptMoneyAction({
    agentId,
    merchantId,
    type: "reward_redeem",
    amountPaise: valuePaise,
    context: `Reward coins redeemed: ${requestedCoins} coins (₹${(valuePaise / 100).toFixed(2)}) against a ₹${(purchaseAmountPaise / 100).toFixed(2)} purchase`,
    rewardLedger: { coinsDelta: -requestedCoins, reason: "redemption", identity },
    idempotencyKey,
  });

  if (result.decision !== "allow") {
    return { decision: "deny", reason: result.reason };
  }

  return { decision: "allow", reason: result.reason, coinsRedeemed: requestedCoins, valuePaise };
}

/** Read-side helper for surfaces that want to show a buyer their own balance without redeeming anything. */
export async function getRewardBalance(merchantId: string, identity: RewardIdentity): Promise<{ enabled: boolean; balance: number; paisePerCoin: number | null }> {
  const settings = await getRewardSettings(merchantId);
  if (!settings) return { enabled: false, balance: 0, paisePerCoin: null };
  const balance = await getCoinBalance(merchantId, identity);
  return { enabled: true, balance, paisePerCoin: settings.paisePerCoin };
}
