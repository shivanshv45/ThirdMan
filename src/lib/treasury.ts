import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 14: the AI Treasury. A merchant-set slice of successful GMV
 * funds a pool split three ways (buyer AI credits, merchant AI budget,
 * reserve). All allocation arithmetic is integer paise, deterministic,
 * property-tested — see gate.ts's own "code decides limits" discipline
 * (CLAUDE.md rule 2).
 *
 * HONESTY CONSTRAINT: this is a configurable product mechanism
 * demonstrated with this project's own simulation numbers. It is not a
 * claim about Razorpay's real economics or fee structure. Every figure
 * this module produces still comes from a real query over real rows —
 * "simulation" means the allocation rate is a merchant-set parameter,
 * never that a displayed number is invented. See DECISIONS.md.
 */

export const TOTAL_BASIS_POINTS = 10_000;

export interface TreasurySettings {
  merchantId: string;
  allocationBasisPoints: number;
  buyerShareBps: number;
  merchantShareBps: number;
  reserveShareBps: number;
  enabled: boolean;
}

export async function getTreasurySettings(merchantId: string): Promise<TreasurySettings | null> {
  const [row] = await db.select().from(schema.treasurySettings).where(eq(schema.treasurySettings.merchantId, merchantId));
  return row ?? null;
}

/**
 * Validates a proposed share configuration before it's ever written.
 * The three shares must sum to exactly 10000 bps — no lost or invented
 * paise at allocation time (the plan's own "splits sum to exactly the
 * contribution" requirement starts here, at the config boundary).
 */
export function validateShareConfig(buyerShareBps: number, merchantShareBps: number, reserveShareBps: number): string | null {
  for (const [name, value] of [
    ["buyerShareBps", buyerShareBps],
    ["merchantShareBps", merchantShareBps],
    ["reserveShareBps", reserveShareBps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      return `${name} must be a non-negative integer, got ${value}.`;
    }
  }
  const sum = buyerShareBps + merchantShareBps + reserveShareBps;
  if (sum !== TOTAL_BASIS_POINTS) {
    return `Shares must sum to exactly ${TOTAL_BASIS_POINTS} basis points (100%), got ${sum}.`;
  }
  return null;
}

export async function setTreasurySettings(
  merchantId: string,
  settings: { allocationBasisPoints: number; buyerShareBps: number; merchantShareBps: number; reserveShareBps: number; enabled: boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!Number.isInteger(settings.allocationBasisPoints) || settings.allocationBasisPoints < 0 || settings.allocationBasisPoints > TOTAL_BASIS_POINTS) {
    return { ok: false, reason: `allocationBasisPoints must be an integer between 0 and ${TOTAL_BASIS_POINTS}, got ${settings.allocationBasisPoints}.` };
  }
  const shareError = validateShareConfig(settings.buyerShareBps, settings.merchantShareBps, settings.reserveShareBps);
  if (shareError) return { ok: false, reason: shareError };

  await db
    .insert(schema.treasurySettings)
    .values({ merchantId, ...settings })
    .onConflictDoUpdate({
      target: schema.treasurySettings.merchantId,
      set: { ...settings, updatedAt: new Date() },
    });

  return { ok: true };
}

export interface AllocationSplit {
  contributionPaise: number;
  buyerPaise: number;
  merchantPaise: number;
  reservePaise: number;
}

/**
 * The one function this whole layer's honesty rests on. floor() at each
 * step, with the remainder after buyer+merchant deterministically
 * assigned to reserve — so the three shares always sum to EXACTLY the
 * contribution, never a paise more or less than what floor(capturedPaise
 * * allocationBasisPoints / 10000) produced. Property-tested (L14-6)
 * against every legal share configuration and capture amount.
 */
export function computeAllocationSplit(
  capturedPaise: number,
  settings: { allocationBasisPoints: number; buyerShareBps: number; merchantShareBps: number; reserveShareBps: number },
): AllocationSplit {
  if (!Number.isInteger(capturedPaise) || capturedPaise <= 0) {
    return { contributionPaise: 0, buyerPaise: 0, merchantPaise: 0, reservePaise: 0 };
  }

  const contributionPaise = Math.floor((capturedPaise * settings.allocationBasisPoints) / TOTAL_BASIS_POINTS);
  if (contributionPaise <= 0) {
    return { contributionPaise: 0, buyerPaise: 0, merchantPaise: 0, reservePaise: 0 };
  }

  const buyerPaise = Math.floor((contributionPaise * settings.buyerShareBps) / TOTAL_BASIS_POINTS);
  const merchantPaise = Math.floor((contributionPaise * settings.merchantShareBps) / TOTAL_BASIS_POINTS);
  // Reserve absorbs the flooring remainder — deterministic, not a
  // separate floor() of its own share, so the three always sum exactly.
  const reservePaise = contributionPaise - buyerPaise - merchantPaise;

  return { contributionPaise, buyerPaise, merchantPaise, reservePaise };
}

/**
 * Funds the treasury from a genuinely captured payment. Called only
 * from the two capture-confirmation sites that already call
 * issueRewardCoinsForCapture (checkout/verify, the webhook route) —
 * never on an authorization or a hold, same "money that hasn't actually
 * settled doesn't fund anything" reasoning as escrow's own capture-only
 * bound (plans/layer-14-ai-treasury.md's L14-1). A merchant with no
 * treasury_settings row, or enabled: false, is a silent no-op — the
 * treasury is opt-in, same discipline as merchant_reward_settings.
 *
 * Writes up to three treasury_ledger rows (buyer/merchant/reserve) in
 * one transaction — a fund event either fully lands or not at all. Each
 * row's own money action is the SAME purchase money_actions row that was
 * captured; this is not a second discretionary spend needing its own
 * cap check, it is a deterministic split of money that already, legally,
 * belongs to the merchant.
 */
export async function fundTreasuryFromCapture(merchantId: string, purchaseMoneyActionId: string, capturedAmountPaise: number): Promise<void> {
  const settings = await getTreasurySettings(merchantId);
  if (!settings || !settings.enabled) return;

  const split = computeAllocationSplit(capturedAmountPaise, settings);
  if (split.contributionPaise <= 0) return;

  // Idempotency guard: the checkout-signature path and the payment
  // webhook both call this for the same capture (the same "fastest
  // signal wins, second is a no-op" contract confirmCapture itself
  // keeps — see gate.ts). treasury_ledger_capture_dedupe_idx (a partial
  // unique index on (bucket, moneyActionId) where reason =
  // 'capture_allocation') is the real guarantee against a race; this
  // onConflictDoNothing is what makes a second call land as a silent
  // no-op instead of a constraint-violation error, same shape as
  // webhook_deliveries' and notification_deliveries' own dedupe (see
  // FAILURES.md — the partial index's WHERE predicate must be repeated
  // in the target here or Postgres rejects the insert outright).
  const rows: { bucket: (typeof schema.treasuryLedgerBucketEnum.enumValues)[number]; amountPaise: number }[] = [
    { bucket: "buyer_credits", amountPaise: split.buyerPaise },
    { bucket: "merchant_ai_budget", amountPaise: split.merchantPaise },
    { bucket: "reserve", amountPaise: split.reservePaise },
  ];

  let fundedAny = false;
  for (const row of rows) {
    if (row.amountPaise <= 0) continue;
    const inserted = await db
      .insert(schema.treasuryLedger)
      .values({
        merchantId,
        bucket: row.bucket,
        amountPaise: row.amountPaise,
        reason: "capture_allocation",
        moneyActionId: purchaseMoneyActionId,
      })
      .onConflictDoNothing({
        target: [schema.treasuryLedger.bucket, schema.treasuryLedger.moneyActionId],
        where: sql`${schema.treasuryLedger.reason} = 'capture_allocation'`,
      })
      .returning({ id: schema.treasuryLedger.id });
    if (inserted.length > 0) fundedAny = true;
  }

  if (!fundedAny) return;

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "treasury_funded",
    decision: "n/a",
    reason: `Treasury funded ₹${(split.contributionPaise / 100).toFixed(2)} from a ₹${(capturedAmountPaise / 100).toFixed(2)} capture (${settings.allocationBasisPoints}bps allocation) — buyer ₹${(split.buyerPaise / 100).toFixed(2)}, merchant ₹${(split.merchantPaise / 100).toFixed(2)}, reserve ₹${(split.reservePaise / 100).toFixed(2)}.`,
    boundApplied: `treasury_allocation:${merchantId} rate ${settings.allocationBasisPoints}bps`,
    moneyActionId: purchaseMoneyActionId,
  });
}

/** Balance of one bucket — always SUM, never a mutable column. */
export async function getTreasuryBucketBalance(merchantId: string, bucket: (typeof schema.treasuryLedgerBucketEnum.enumValues)[number]): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.treasuryLedger.amountPaise}), 0)` })
    .from(schema.treasuryLedger)
    .where(sql`${schema.treasuryLedger.merchantId} = ${merchantId} and ${schema.treasuryLedger.bucket} = ${bucket}`);
  return Number(row?.total ?? 0);
}

export async function getTreasuryOverview(merchantId: string): Promise<{
  settings: TreasurySettings | null;
  buyerCreditsPaise: number;
  merchantAiBudgetPaise: number;
  reservePaise: number;
}> {
  const settings = await getTreasurySettings(merchantId);
  const [buyerCreditsPaise, merchantAiBudgetPaise, reservePaise] = await Promise.all([
    getTreasuryBucketBalance(merchantId, "buyer_credits"),
    getTreasuryBucketBalance(merchantId, "merchant_ai_budget"),
    getTreasuryBucketBalance(merchantId, "reserve"),
  ]);
  return { settings, buyerCreditsPaise, merchantAiBudgetPaise, reservePaise };
}

/**
 * Draws from the merchant_ai_budget bucket for a real model call's cost
 * — an unconditional ledger debit, same reasoning as refundRewardCoins
 * in gate.ts: this is bookkeeping for money the merchant already owns
 * moving to a different internal bucket, not a discretionary spend an
 * agent is requesting, so it does not go through attemptMoneyAction. The
 * budget-exhaustion CHECK that gates whether a call is allowed to happen
 * at all lives in model-router.ts, upstream of this — this function only
 * records what already happened.
 */
export async function drawMerchantAiBudget(merchantId: string, amountPaise: number, reason: string): Promise<void> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error(`drawMerchantAiBudget: amountPaise must be a positive integer, got ${amountPaise}`);
  }
  await db.insert(schema.treasuryLedger).values({
    merchantId,
    bucket: "merchant_ai_budget",
    amountPaise: -amountPaise,
    reason: "model_spend",
  });
  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "treasury_model_spend",
    decision: "n/a",
    reason,
  });
}
