import { eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, refundRewardCoins } from "@/lib/gate";
import { getCoinBalance, getRewardSettings, coinsToValuePaise, type RewardIdentity } from "@/lib/reward-coins";
import { complete } from "@/lib/llm";
import { logAuditEntry } from "@/lib/audit";

/**
 * Reward coins redeemable for AI usage on this platform (Layer 11-8).
 * Not a second currency — this reuses the exact same reward_coin_ledger
 * every other coin issuance/redemption writes to (reason: "redemption"),
 * through the same gate path as reward-actions.ts.
 *
 * The tiers are real Groq-served models, under their real names,
 * queried live from Groq's own model list before being hardcoded here
 * (see scripts/seed.ts) — never another vendor's model name over a
 * Groq response. See DECISIONS.md and CLAUDE.md's design rule 14 (no
 * fabricated data in the UI).
 */

export interface AiCreditTier {
  id: string;
  merchantId: string;
  modelId: string;
  displayName: string;
  provider: string;
  coinsPerRequest: number;
  enabled: boolean;
}

export async function getEnabledTiers(merchantId: string): Promise<AiCreditTier[]> {
  return db
    .select()
    .from(schema.aiCreditTiers)
    .where(and(eq(schema.aiCreditTiers.merchantId, merchantId), eq(schema.aiCreditTiers.enabled, true)));
}

export interface RedeemAiCreditResult {
  decision: "allow" | "deny";
  reason: string;
  responseText?: string;
  providerServed?: string;
  coinsSpent?: number;
}

/**
 * Spends coins for one AI response at a named tier's price. Balance is
 * checked, then debited, THEN the model is called — never the reverse.
 * A model failure after the debit refunds the exact same coins in the
 * same call, through the same gate path (a second, real, audited
 * ledger entry — not a rollback that pretends the first entry never
 * happened), so a customer never pays coins for nothing even though no
 * rupees ever moved. CLAUDE.md rule 1 covers coin issuance/redemption
 * explicitly as a money action.
 *
 * agentId here is whichever real agent's spend cap answers for this
 * debit — for a session-based storefront buyer, the caller resolves
 * the same hidden __storefront_checkout agent
 * (storefront.ts's getOrCreateStorefrontAgent) that
 * /api/checkout/redeem-coins already uses, exactly like every other
 * session-identity money action in this codebase. identity is separate
 * because the LEDGER's own balance query keys off sessionToken (or a
 * genuine external agent's own id), not off whichever hidden agent
 * happens to answer for the spend cap.
 */
export async function redeemAiCredit(merchantId: string, agentId: string, tierId: string, identity: RewardIdentity, prompt: string): Promise<RedeemAiCreditResult> {
  const [tier] = await db
    .select()
    .from(schema.aiCreditTiers)
    .where(and(eq(schema.aiCreditTiers.id, tierId), eq(schema.aiCreditTiers.merchantId, merchantId), eq(schema.aiCreditTiers.enabled, true)));

  if (!tier) {
    return { decision: "deny", reason: "This tier is not available." };
  }

  // A merchant must have a rewards program configured for coins to
  // carry a real paise-equivalent value at all — and if they don't,
  // no coins could ever have been issued, so the balance check below
  // would deny anyway. Fetched here explicitly rather than assumed,
  // fail closed with a specific reason if it's somehow missing.
  const settings = await getRewardSettings(merchantId);
  if (!settings) {
    return { decision: "deny", reason: "This merchant has not enabled a rewards program." };
  }

  const balance = await getCoinBalance(merchantId, identity);
  if (balance < tier.coinsPerRequest) {
    return { decision: "deny", reason: `Denied — this tier costs ${tier.coinsPerRequest} coins, but only ${balance} are available.` };
  }

  const valuePaise = coinsToValuePaise(tier.coinsPerRequest, settings);

  const debit = await attemptMoneyAction({
    agentId,
    merchantId,
    type: "reward_redeem",
    amountPaise: valuePaise,
    context: `AI credit redemption: ${tier.coinsPerRequest} coins for one response from "${tier.displayName}"`,
    rewardLedger: { coinsDelta: -tier.coinsPerRequest, reason: "redemption", identity },
  });

  if (debit.decision !== "allow") {
    return { decision: "deny", reason: debit.reason };
  }

  try {
    const { text, provider } = await complete({ prompt, groqModelOverride: tier.modelId });

    await db.insert(schema.aiCreditRedemptions).values({
      merchantId,
      tierId: tier.id,
      agentId: identity.agentId,
      sessionToken: identity.sessionToken,
      coinsSpent: tier.coinsPerRequest,
      rewardLedgerId: await findLedgerRowId(debit.moneyActionId),
      promptExcerpt: prompt.slice(0, 500),
      responseExcerpt: text.slice(0, 500),
      providerServed: provider,
      succeeded: true,
    });

    await logAuditEntry({
      merchantId,
      actor: identity.agentId ? "agent" : "customer",
      event: "ai_credit_redeemed",
      decision: "allow",
      reason: `Spent ${tier.coinsPerRequest} coins on one response from "${tier.displayName}" (served by ${provider}).`,
      moneyActionId: debit.moneyActionId,
      metadata: { tierId: tier.id, provider },
    });

    return { decision: "allow", reason: "Redeemed.", responseText: text, providerServed: provider, coinsSpent: tier.coinsPerRequest };
  } catch (err) {
    // The model call failed AFTER coins were already debited — refund
    // them unconditionally via gate.ts's refundRewardCoins(), NOT
    // attemptMoneyAction(). A real bug caught this: routing the refund
    // through attemptMoneyAction sent it through the live risk layer
    // like any other discretionary spend, and a model call once
    // assessed a refund as "escalate" — leaving it stuck in
    // pending_escalation instead of back in the buyer's balance. A
    // refund is a correction of money already taken, not a new
    // request for a risk model to second-guess (the same reasoning
    // issueRefund() in gate.ts already applies to a real Razorpay
    // refund). See FAILURES.md.
    const refund = await refundRewardCoins(merchantId, agentId, tier.coinsPerRequest, identity, `model call failed after debit for tier "${tier.displayName}"`);

    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "ai_credit_refunded",
      decision: "deny",
      reason: `Model call failed for tier "${tier.displayName}" after ${tier.coinsPerRequest} coins were debited — refunded in full. Error: ${err instanceof Error ? err.message : String(err)}`,
      moneyActionId: refund.moneyActionId,
      metadata: { tierId: tier.id },
    });

    return { decision: "deny", reason: "The model call failed — your coins have been refunded." };
  }
}

async function findLedgerRowId(moneyActionId: string | undefined): Promise<string> {
  if (!moneyActionId) throw new Error("findLedgerRowId: no moneyActionId on a successful debit — this is a gate contract violation");
  const [row] = await db.select({ id: schema.rewardCoinLedger.id }).from(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.moneyActionId, moneyActionId));
  if (!row) throw new Error(`findLedgerRowId: no reward_coin_ledger row for money action ${moneyActionId}`);
  return row.id;
}
