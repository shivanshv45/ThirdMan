import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { createOrder, capturePayment, refundPayment, createPaymentLink, RazorpayCallError, type RazorpayCredentials } from "@/lib/razorpay";
import { decrypt } from "@/lib/crypto";
import { computeRiskSignals, assessRisk } from "@/lib/risk";
import { resolveOffer, loadOfferItems, type ResolvedOffer } from "@/lib/discount";
import { resolveNegotiation, markNegotiationRedeemed, type ResolvedNegotiation } from "@/lib/negotiation";
import { resolveCartForCheckout, snapshotCartPurchase, loadCartPurchaseItems, type ResolvedCart } from "@/lib/cart";

/**
 * Loads and decrypts a merchant's own Razorpay credentials. The gate is
 * the only place that does this — feature code never reaches crypto.ts
 * or razorpay.ts directly. Returns null if the merchant hasn't connected
 * an account yet, which checkBounds treats as a deny, not a crash.
 */
async function loadMerchantCredentials(merchantId: string): Promise<RazorpayCredentials | null> {
  const [merchant] = await db
    .select({
      keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted,
      keySecretEncrypted: schema.merchants.razorpayKeySecretEncrypted,
    })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant?.keyIdEncrypted || !merchant?.keySecretEncrypted) {
    return null;
  }

  return {
    keyId: decrypt(merchant.keyIdEncrypted),
    keySecret: decrypt(merchant.keySecretEncrypted),
  };
}

/**
 * The only path to a money action in this codebase. Every feature layer
 * built on top of this (checkout, negotiation, upsell, payouts, recovery)
 * must call attemptMoneyAction instead of reaching razorpay.ts directly.
 * See ARCHITECTURE.md, "The gate contract."
 *
 * Every check here is deterministic. No model is consulted for any
 * bound, cap, or arithmetic decision. See CLAUDE.md.
 */

export type GateDecision = "allow" | "deny" | "escalate";

export interface MoneyActionRequest {
  agentId: string;
  merchantId: string;
  type: (typeof schema.moneyActionTypeEnum.enumValues)[number];
  amountPaise: number;
  /** What is being bought, for the audit trail and the risk-assessment layer. */
  context: string;
  /** Agents retry. A repeat with the same key returns the original outcome instead of reserving budget twice. */
  idempotencyKey?: string;
  /**
   * When present, the price comes from this variant's row, never from
   * amountPaise as supplied by the caller. If amountPaise is also given
   * and disagrees with variantPrice * quantity, that is a deny — a buyer
   * agent that thinks the price is different has a bug or is probing.
   * (Layer 5-1: renamed from productId — a purchase resolves against a
   * specific sellable variant, not the marketing-level product row.)
   */
  variantId?: string;
  /** Only meaningful alongside variantId. Defaults to 1. */
  quantity?: number;
  /**
   * The escrow hold-and-capture flow (Layer 4-5): when true, the
   * Razorpay order is created with payment_capture: false, so a
   * successful checkout authorises the payment without capturing it.
   * confirmCapture reads this back off the stored row to know whether a
   * verified payment should land as "held" (awaiting a merchant
   * decision) or go straight to "captured".
   */
  holdOnly?: boolean;
  /**
   * The recovery pipeline's retry/nudge strategies (Layer 4-3): instead
   * of creating a Razorpay order, create a real Payment Link a customer
   * can complete asynchronously. Still reserves budget through the same
   * bound checks as any other action — only what gets created after
   * "allow" differs. razorpayEntityId stores the link id;
   * GateResult.paymentLinkUrl carries the payable URL.
   */
  paymentLink?: { description: string; referenceId: string };
  /**
   * Layer 6: redeem a previously-accepted upsell offer instead of a
   * single variant. Mutually exclusive with variantId — an offer already
   * names the variants and quantities it covers (discount.ts's
   * resolveOffer). If amountPaise is also given and disagrees with the
   * offer's own bundlePricePaise, that is a deny — same discipline as
   * variantId's price-match check. The caller can reference an offer,
   * never assert its price.
   */
  offerId?: string;
  /**
   * Identifies the buyer redeeming an offer or negotiation when there is
   * no agent identity to match against (the storefront/chat's
   * session-based flows) — see discount.ts's resolveOffer and
   * negotiation.ts's resolveNegotiation identity checks.
   */
  sessionToken?: string;
  /**
   * Layer 8: redeem an agreed negotiated price instead of a plain
   * variant or a bundle offer. Mutually exclusive with variantId and
   * offerId — a negotiation already names the variant, quantity, and
   * agreed price it covers (negotiation.ts's resolveNegotiation). If
   * amountPaise is also given and disagrees with the negotiation's own
   * agreed amount, that is a deny — same discipline as variantId's
   * price-match check and offerId's offer_price_match. The caller can
   * only reference an agreed negotiation, never assert its price.
   */
  negotiationId?: string;
  /**
   * Layer 6-5: a reward-coin issuance or redemption. amountPaise is
   * still the coins' paise-equivalent value (reward-coins.ts computes
   * it) and is still bounded by the same spend-cap checks as any other
   * action — coins are real value leaving the merchant's business.
   * executeAndSettle branches on this field: it writes a
   * reward_coin_ledger row instead of calling Razorpay, since neither
   * direction has a Razorpay counterpart. type must be "reward_issue" or
   * "reward_redeem" to match.
   */
  rewardLedger?: {
    coinsDelta: number;
    reason: (typeof schema.rewardLedgerReasonEnum.enumValues)[number];
    identity: { agentId?: string; sessionToken?: string };
  };
  /**
   * Layer 9-close-out: check out a genuine multi-item cart (multiple
   * distinct variants, one order) instead of a single variantId. Names a
   * conversationId — the gate re-derives the total and every line's
   * price/stock fresh from cart.ts's resolveCartForCheckout, never from
   * anything the caller asserted. Mutually exclusive with
   * variantId/offerId/negotiationId — a cart already names every variant
   * and quantity it covers.
   */
  cartConversationId?: string;
}

export interface GateResult {
  decision: GateDecision;
  reason: string;
  moneyActionId?: string;
  /** Only present on decision: "allow" with a successfully executed action. */
  razorpayOrderId?: string;
  /** Only present when the request set paymentLink and it was created successfully. */
  paymentLinkUrl?: string;
  /** Only present alongside paymentLinkUrl — the Razorpay Payment Link id, for matching webhook/attempt rows back to this action. */
  paymentLinkId?: string;
}

interface BoundCheckFailure {
  reason: string;
  boundApplied: string;
}

interface ResolvedVariant {
  id: string;
  productId: string;
  stock: number;
}

interface BoundCheckSuccess {
  /** Present only when the request named a variantId and it resolved cleanly. */
  variant?: ResolvedVariant;
  /** Present only when the request named an offerId and it resolved cleanly (Layer 6). */
  offer?: ResolvedOffer;
  /** Present only when the request named a negotiationId and it resolved cleanly (Layer 8). */
  negotiation?: ResolvedNegotiation;
  /** Present only when the request named a cartConversationId and it resolved cleanly (Layer 9-close-out). */
  cart?: ResolvedCart;
}

/**
 * Looks up a variant and validates it against the request before any
 * budget or stock is touched: it must belong to the same merchant as the
 * agent, be active, its price must match what the caller asserted in
 * amountPaise exactly, and it must have enough stock. The price itself
 * always comes from this row, never from the caller. (Layer 5-1: resolves
 * product_variants, not products — a purchase is always against a
 * specific sellable variant.)
 */
async function resolveVariant(
  request: MoneyActionRequest,
): Promise<{ variant?: ResolvedVariant; failure?: BoundCheckFailure }> {
  const quantity = request.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      failure: {
        reason: `Denied — quantity ${quantity} is not a positive integer.`,
        boundApplied: "quantity_validity",
      },
    };
  }

  const [variant] = await db
    .select()
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, request.variantId!));

  if (!variant || variant.merchantId !== request.merchantId) {
    return {
      failure: {
        reason: `Denied — no product ${request.variantId} found for this merchant.`,
        boundApplied: "product_exists",
      },
    };
  }

  if (variant.status !== "active") {
    return {
      failure: {
        reason: `Denied — product "${variant.sku}" is ${variant.status}, not active.`,
        boundApplied: `product_status:${variant.id}`,
      },
    };
  }

  const catalogueAmountPaise = variant.pricePaise * quantity;

  if (request.amountPaise !== catalogueAmountPaise) {
    return {
      failure: {
        reason: `Denied — caller asserted ₹${(request.amountPaise / 100).toFixed(2)} for "${variant.sku}" x${quantity}, but the catalogue price is ₹${(catalogueAmountPaise / 100).toFixed(2)}. Price comes from the catalogue, never the caller.`,
        boundApplied: `product_price_match:${variant.id}`,
      },
    };
  }

  if (variant.stock < quantity) {
    return {
      failure: {
        reason: `Denied — "${variant.sku}" has ${variant.stock} in stock, but ${quantity} were requested.`,
        boundApplied: "product_stock",
      },
    };
  }

  return { variant: { id: variant.id, productId: variant.productId, stock: variant.stock } };
}

/**
 * Resolves an offerId into what the gate will actually charge and
 * reserve (Layer 6): discount.ts does the offer/bundle lookup and every
 * identity/expiry/status check; this only adds the two checks every
 * money action needs regardless of how the amount was derived — the
 * caller's asserted amountPaise must match exactly, and every bundle
 * item must have enough stock. Mirrors resolveVariant's shape and
 * ordering so the two paths read the same way.
 */
async function resolveOfferForRequest(
  request: MoneyActionRequest,
): Promise<{ offer?: ResolvedOffer; failure?: BoundCheckFailure }> {
  const { offer, failure } = await resolveOffer(request.merchantId, request.offerId!, {
    agentId: request.agentId,
    sessionToken: request.sessionToken,
  });
  if (failure) return { failure };

  if (request.amountPaise !== offer!.amountPaise) {
    return {
      failure: {
        reason: `Denied — caller asserted ₹${(request.amountPaise / 100).toFixed(2)} for offer ${offer!.offerId}, but the bundle price is ₹${(offer!.amountPaise / 100).toFixed(2)}. Price comes from the merchant-authored bundle, never the caller.`,
        boundApplied: `offer_price_match:${offer!.offerId}`,
      },
    };
  }

  for (const item of offer!.items) {
    const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, item.variantId));
    if (!variant || variant.stock < item.quantity) {
      return {
        failure: {
          reason: `Denied — offer ${offer!.offerId}'s bundle needs ${item.quantity} of variant ${item.variantId}, but only ${variant?.stock ?? 0} in stock.`,
          boundApplied: "offer_bundle_stock",
        },
      };
    }
  }

  return { offer };
}

/**
 * Resolves a negotiationId into what the gate will actually charge and
 * reserve (Layer 8): negotiation.ts does the negotiation lookup, the
 * agreed-status/expiry/identity checks, and re-derives the amount from
 * the agreed price — never from anything the caller asserted. This only
 * adds the two checks every money action needs regardless of how the
 * amount was derived — the caller's asserted amountPaise must match
 * exactly, and the variant must still have enough stock. Mirrors
 * resolveOfferForRequest's shape and ordering exactly.
 */
async function resolveNegotiationForRequest(
  request: MoneyActionRequest,
): Promise<{ negotiation?: ResolvedNegotiation; failure?: BoundCheckFailure }> {
  const { resolved, failure } = await resolveNegotiation(request.merchantId, request.negotiationId!, {
    agentId: request.agentId,
    sessionToken: request.sessionToken,
  });
  if (failure) return { failure };

  if (request.amountPaise !== resolved!.amountPaise) {
    return {
      failure: {
        reason: `Denied — caller asserted ₹${(request.amountPaise / 100).toFixed(2)} for negotiation ${resolved!.negotiationId}, but the agreed price is ₹${(resolved!.amountPaise / 100).toFixed(2)}. Price comes from the agreed negotiation, never the caller.`,
        boundApplied: `negotiation_price_match:${resolved!.negotiationId}`,
      },
    };
  }

  const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, resolved!.variantId));
  if (!variant || variant.stock < resolved!.quantity) {
    return {
      failure: {
        reason: `Denied — negotiation ${resolved!.negotiationId} needs ${resolved!.quantity} of "${variant?.sku ?? resolved!.variantId}", but only ${variant?.stock ?? 0} in stock.`,
        boundApplied: "negotiation_stock",
      },
    };
  }

  return { negotiation: resolved };
}

/**
 * Resolves a cartConversationId into what the gate will actually charge
 * and reserve (Layer 9-close-out): cart.ts does the live re-read of
 * every line's price and stock; this only adds the check every money
 * action needs regardless of how the amount was derived — the caller's
 * asserted amountPaise must match the freshly-computed cart total
 * exactly. Mirrors resolveOfferForRequest's shape and ordering.
 */
async function resolveCartForRequest(
  request: MoneyActionRequest,
): Promise<{ cart?: ResolvedCart; failure?: BoundCheckFailure }> {
  const { cart, failure } = await resolveCartForCheckout(request.merchantId, request.cartConversationId!);
  if (failure) return { failure };

  if (request.amountPaise !== cart!.amountPaise) {
    return {
      failure: {
        reason: `Denied — caller asserted ₹${(request.amountPaise / 100).toFixed(2)} for the cart, but the catalogue total is ₹${(cart!.amountPaise / 100).toFixed(2)}. Price comes from the catalogue, never the caller.`,
        boundApplied: `cart_price_match:${cart!.conversationId}`,
      },
    };
  }

  return { cart };
}

/**
 * The deterministic checks, in order, short-circuiting on the first
 * failure. Returns the resolved product (if any) when every check passes.
 */
async function checkBounds(
  request: MoneyActionRequest,
): Promise<BoundCheckFailure | BoundCheckSuccess> {
  // A request naming more than one of variantId/offerId/negotiationId/
  // cartConversationId is ambiguous about what it's actually buying — a
  // bug or a probe, not something to resolve by precedence
  // (plans/layer-8-negotiation.md, fact 4; extended Layer 9-close-out).
  const namedTargets = [request.variantId, request.offerId, request.negotiationId, request.cartConversationId].filter(Boolean).length;
  if (namedTargets > 1) {
    return {
      reason: "Denied — request named more than one of variantId, offerId, negotiationId, and cartConversationId. Exactly one may be present.",
      boundApplied: "purchase_target_ambiguous",
    };
  }

  if (!Number.isInteger(request.amountPaise) || request.amountPaise <= 0) {
    return {
      reason: `Denied — amount ${request.amountPaise} is not a positive integer number of paise.`,
      boundApplied: "amount_validity",
    };
  }

  const credentials = await loadMerchantCredentials(request.merchantId);
  if (!credentials) {
    return {
      reason: "Denied — this merchant has not connected a Razorpay account yet. Connect one in Settings before agents can transact.",
      boundApplied: "merchant_razorpay_connected",
    };
  }

  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, request.agentId));

  if (!agent) {
    return {
      reason: `Denied — no agent found with id ${request.agentId}.`,
      boundApplied: "agent_exists",
    };
  }

  if (agent.status !== "active") {
    return {
      reason: `Denied — agent "${agent.name}" is ${agent.status}, not active. Revoked agents can never transact.`,
      boundApplied: `agent_status:${agent.id}`,
    };
  }

  const [cap] = await db
    .select()
    .from(schema.spendCaps)
    .where(eq(schema.spendCaps.agentId, request.agentId))
    .orderBy(sql`${schema.spendCaps.createdAt} desc`)
    .limit(1);

  if (!cap) {
    return {
      reason: `Denied — agent "${agent.name}" has no spend cap. Absence of a bound is not permission.`,
      boundApplied: "spend_cap_exists",
    };
  }

  if (cap.status !== "active") {
    return {
      reason: `Denied — spend cap ${cap.id} is ${cap.status}, not active.`,
      boundApplied: `spend_cap_status:${cap.id}`,
    };
  }

  const now = new Date();
  if (now < cap.windowStart || now > cap.windowEnd) {
    // Mark it expired so future checks can short-circuit on cap.status.
    await db
      .update(schema.spendCaps)
      .set({ status: "expired" })
      .where(eq(schema.spendCaps.id, cap.id));

    return {
      reason: `Denied — spend cap ${cap.id}'s window (${cap.windowStart.toISOString()} to ${cap.windowEnd.toISOString()}) has lapsed. Marked expired.`,
      boundApplied: `spend_cap_window:${cap.id}`,
    };
  }

  if (request.amountPaise > cap.perTransactionMaxPaise) {
    return {
      reason: `Denied — ₹${(request.amountPaise / 100).toFixed(2)} exceeds this agent's per-transaction limit of ₹${(cap.perTransactionMaxPaise / 100).toFixed(2)}, even though the window total may allow it.`,
      boundApplied: `per_transaction_max:${cap.id}`,
    };
  }

  const remainingPaise = cap.capPaise - cap.spentPaise;
  if (request.amountPaise > remainingPaise) {
    return {
      reason: `Denied — ₹${(request.amountPaise / 100).toFixed(2)} exceeds the ₹${(remainingPaise / 100).toFixed(2)} remaining in this agent's ₹${(cap.capPaise / 100).toFixed(2)} cap (₹${(cap.spentPaise / 100).toFixed(2)} already spent this window).`,
      boundApplied: `spend_cap_balance:${cap.id}`,
    };
  }

  if (request.offerId) {
    const { offer, failure } = await resolveOfferForRequest(request);
    if (failure) return failure;
    return { offer };
  }

  if (request.negotiationId) {
    const { negotiation, failure } = await resolveNegotiationForRequest(request);
    if (failure) return failure;
    return { negotiation };
  }

  if (request.cartConversationId) {
    const { cart, failure } = await resolveCartForRequest(request);
    if (failure) return failure;
    return { cart };
  }

  if (request.variantId) {
    const { variant, failure } = await resolveVariant(request);
    if (failure) return failure;
    return { variant };
  }

  return {};
}

function isBoundFailure(
  result: BoundCheckFailure | BoundCheckSuccess,
): result is BoundCheckFailure {
  return "reason" in result;
}

/**
 * Atomically reserves amountPaise against the agent's active spend cap.
 * The WHERE clause re-verifies the balance in the same statement as the
 * increment, so two concurrent requests racing for the same headroom
 * leave exactly one UPDATE affecting a row and the other affecting zero.
 * That is what makes this safe under concurrency without table locking.
 */
async function reserveBudget(
  capId: string,
  amountPaise: number,
): Promise<boolean> {
  const result = await db
    .update(schema.spendCaps)
    .set({ spentPaise: sql`${schema.spendCaps.spentPaise} + ${amountPaise}` })
    .where(
      and(
        eq(schema.spendCaps.id, capId),
        eq(schema.spendCaps.status, "active"),
        lte(
          sql`${schema.spendCaps.spentPaise} + ${amountPaise}`,
          schema.spendCaps.capPaise,
        ),
      ),
    )
    .returning({ id: schema.spendCaps.id });

  return result.length > 0;
}

/** Gives budget back to the cap. Called when a reserved money action fails to execute. */
async function releaseBudget(capId: string, amountPaise: number): Promise<void> {
  await db
    .update(schema.spendCaps)
    .set({ spentPaise: sql`greatest(${schema.spendCaps.spentPaise} - ${amountPaise}, 0)` })
    .where(eq(schema.spendCaps.id, capId));
}

/**
 * Atomically decrements variant stock. Same pattern as reserveBudget: the
 * WHERE clause re-checks stock >= quantity in the same statement as the
 * decrement, so concurrent purchases racing for the last units leave
 * exactly the available count succeeding, never negative stock.
 * (Layer 5-1: operates on product_variants, not products.)
 */
async function reserveStock(variantId: string, quantity: number): Promise<boolean> {
  const result = await db
    .update(schema.productVariants)
    .set({ stock: sql`${schema.productVariants.stock} - ${quantity}` })
    .where(and(eq(schema.productVariants.id, variantId), gte(schema.productVariants.stock, quantity)))
    .returning({ id: schema.productVariants.id });

  return result.length > 0;
}

/** Gives stock back to the variant. Called when a reserved money action fails to execute or an escalation is rejected. */
async function releaseStock(variantId: string, quantity: number): Promise<void> {
  await db
    .update(schema.productVariants)
    .set({ stock: sql`${schema.productVariants.stock} + ${quantity}` })
    .where(eq(schema.productVariants.id, variantId));
}

/**
 * An offer's bundle covers multiple variants (Layer 6) — reserves stock
 * for every item, all-or-nothing. If any item loses the race (another
 * purchase took the last units between resolveOfferForRequest's read and
 * now), every item already reserved in this call is rolled back before
 * returning false, so a bundle purchase never leaves a partial hold on
 * some of its items.
 */
async function reserveOfferStock(items: ResolvedOffer["items"]): Promise<boolean> {
  const reservedSoFar: ResolvedOffer["items"] = [];
  for (const item of items) {
    const ok = await reserveStock(item.variantId, item.quantity);
    if (!ok) {
      for (const done of reservedSoFar) await releaseStock(done.variantId, done.quantity);
      return false;
    }
    reservedSoFar.push(item);
  }
  return true;
}

/** Gives back stock for every item in an offer's bundle. Mirrors releaseStock. */
async function releaseOfferStock(items: ResolvedOffer["items"]): Promise<void> {
  for (const item of items) await releaseStock(item.variantId, item.quantity);
}

/**
 * Inserts the money_actions row after budget is already reserved. If two
 * concurrent requests share the same idempotency key, both can pass the
 * earlier idempotency check (before either has a row yet) and both reach
 * here — the unique index on (agentId, idempotencyKey) lets exactly one
 * insert win. The loser releases its own reservation and replays the
 * winner's row instead of creating a duplicate.
 */
async function insertMoneyActionOrReplay(
  capId: string,
  values: typeof schema.moneyActions.$inferInsert,
): Promise<{ action: typeof schema.moneyActions.$inferSelect; wasReplay: boolean }> {
  try {
    const [action] = await db.insert(schema.moneyActions).values(values).returning();
    return { action, wasReplay: false };
  } catch (err) {
    // drizzle wraps the raw postgres error, putting the actual PostgresError
    // (with its .code) on err.cause rather than on err itself.
    const pgCode = (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode !== "23505" || !values.idempotencyKey) throw err;

    await releaseBudget(capId, values.amountPaise);
    if (values.variantId) {
      await releaseStock(values.variantId, values.quantity ?? 1);
    }
    if (values.offerId) {
      await releaseOfferStock(await loadOfferItems(values.offerId));
    }
    if (values.cartId) {
      await releaseOfferStock(await loadCartPurchaseItems(values.cartId));
    }
    const [existing] = await db
      .select()
      .from(schema.moneyActions)
      .where(
        and(
          eq(schema.moneyActions.agentId, values.agentId!),
          eq(schema.moneyActions.idempotencyKey, values.idempotencyKey),
        ),
      );
    if (!existing) throw err;
    return { action: existing, wasReplay: true };
  }
}

interface ExecuteAndSettleInput {
  merchantId: string;
  moneyActionId: string;
  capId: string;
  amountPaise: number;
  context: string;
  agentId: string;
  actor: (typeof schema.auditActorEnum.enumValues)[number];
  allowReasonPrefix: string;
  /** Present only when this action bought a specific variant — stock held for it releases alongside budget on failure. */
  variantId?: string;
  quantity?: number;
  /** Present only when this action redeemed an offer's bundle (Layer 6) — every item's stock releases alongside budget on failure. */
  offerItems?: ResolvedOffer["items"];
  /** Escrow (Layer 4-5): create the order with payment_capture: false so a successful checkout only authorises, never auto-captures. */
  holdOnly?: boolean;
  /** Recovery (Layer 4-3): create a real Payment Link instead of an order. */
  paymentLink?: { description: string; referenceId: string };
  /** Layer 6-5: settle as a reward-coin ledger write instead of a Razorpay call. See MoneyActionRequest.rewardLedger. */
  rewardLedger?: MoneyActionRequest["rewardLedger"];
}

/**
 * Executes a reserved money action against Razorpay and settles it:
 * commits on success, releases the reservation on failure. Shared by
 * both attemptMoneyAction's direct-allow path and resolveEscalation's
 * approve path, since both start from budget already reserved.
 */
async function executeAndSettle(input: ExecuteAndSettleInput): Promise<GateResult> {
  try {
    // Layer 6-5: a reward-coin issuance or redemption has no Razorpay
    // counterpart — coins are an internal ledger, not money leaving or
    // entering the merchant's Razorpay account. Settle by writing the
    // ledger row directly rather than reaching razorpay.ts at all.
    // checkBounds already required this merchant to have connected
    // Razorpay before reaching here (deliberately not special-cased —
    // a merchant running a rewards program is already selling real
    // product through Razorpay). A DB failure here still hits the catch
    // block below and releases the reservation, same as any other path.
    if (input.rewardLedger) {
      const { coinsDelta, reason: ledgerReason, identity } = input.rewardLedger;

      // A redemption (negative delta) must be atomic against the live
      // balance the same way reserveStock/reserveBudget are atomic
      // against their own resource: the balance is re-summed from this
      // exact identity's ledger rows and re-checked in the SAME
      // statement as the insert, via a conditional INSERT ... SELECT.
      // Two concurrent redemptions racing for the same balance leave
      // exactly one INSERT affecting a row and the other affecting zero
      // — the balance can never go negative, without a second mutable
      // "balance" column that could diverge from the ledger it's
      // supposed to summarize (see DECISIONS.md's recoveredPaise
      // reasoning). An issuance (positive delta) always succeeds — it
      // never needs this check.
      const identityFilter = identity.agentId
        ? sql`agent_id = ${identity.agentId}`
        : sql`session_token = ${identity.sessionToken}`;

      const inserted = await db.execute<{ id: string }>(sql`
        insert into ${schema.rewardCoinLedger} (merchant_id, agent_id, session_token, coins_delta, reason, money_action_id)
        select ${input.merchantId}, ${identity.agentId ?? null}, ${identity.sessionToken ?? null}, ${coinsDelta}, ${ledgerReason}, ${input.moneyActionId}
        where ${coinsDelta} > 0 or (
          coalesce((
            select sum(coins_delta) from ${schema.rewardCoinLedger}
            where merchant_id = ${input.merchantId} and ${identityFilter}
          ), 0) + ${coinsDelta} >= 0
        )
        returning id
      `);

      if (inserted.length === 0) {
        // Lost the race for the last of the balance between check and
        // reservation — same shape as reserveStock's own concurrency
        // loss, and it releases budget the same way.
        await releaseBudget(input.capId, input.amountPaise);
        await db.update(schema.moneyActions).set({ status: "failed" }).where(eq(schema.moneyActions.id, input.moneyActionId));

        const reason = "Denied — another request consumed the remaining coin balance between check and reservation. Reserved budget released.";
        await logAuditEntry({
          merchantId: input.merchantId,
          actor: input.actor,
          event: "money_action_execution_failed",
          decision: "deny",
          reason,
          boundApplied: "reward_coin_balance",
          moneyActionId: input.moneyActionId,
        });

        return { decision: "deny", reason, moneyActionId: input.moneyActionId };
      }

      await db
        .update(schema.moneyActions)
        .set({ status: "executed" })
        .where(eq(schema.moneyActions.id, input.moneyActionId));

      const reason = `${input.allowReasonPrefix} and the reward-coin ledger was updated (${coinsDelta > 0 ? "+" : ""}${coinsDelta} coins).`;
      await logAuditEntry({
        merchantId: input.merchantId,
        actor: input.actor,
        event: "money_action_executed",
        decision: "allow",
        reason,
        boundApplied: `spend_cap_balance:${input.capId}`,
        moneyActionId: input.moneyActionId,
        metadata: { coinsDelta, rewardReason: ledgerReason },
      });

      return { decision: "allow", reason, moneyActionId: input.moneyActionId };
    }

    // Loaded fresh rather than passed through from checkBounds, so a
    // credential rotation or disconnect between attempt and execution
    // (the gap matters most for resolveEscalation, which can run long
    // after the original attempt) is caught here too, not just at attempt time.
    const credentials = await loadMerchantCredentials(input.merchantId);
    if (!credentials) {
      throw new Error("Merchant's Razorpay account is no longer connected");
    }

    if (input.paymentLink) {
      const link = await createPaymentLink(credentials, {
        amountPaise: input.amountPaise,
        description: input.paymentLink.description,
        referenceId: input.paymentLink.referenceId,
      });

      await db
        .update(schema.moneyActions)
        .set({ status: "executed", razorpayEntityId: link.id })
        .where(eq(schema.moneyActions.id, input.moneyActionId));

      const reason = `${input.allowReasonPrefix} and a real payment link was created successfully.`;
      await logAuditEntry({
        merchantId: input.merchantId,
        actor: input.actor,
        event: "money_action_executed",
        decision: "allow",
        reason,
        boundApplied: `spend_cap_balance:${input.capId}`,
        moneyActionId: input.moneyActionId,
        metadata: { razorpayPaymentLinkId: link.id, paymentLinkUrl: link.shortUrl },
      });

      return { decision: "allow", reason, moneyActionId: input.moneyActionId, paymentLinkUrl: link.shortUrl, paymentLinkId: link.id };
    }

    const order = await createOrder(credentials, {
      amountPaise: input.amountPaise,
      receipt: input.moneyActionId,
      notes: { agentId: input.agentId, context: input.context },
      autoCapture: !input.holdOnly,
    });

    await db
      .update(schema.moneyActions)
      .set({ status: "executed", razorpayEntityId: order.id })
      .where(eq(schema.moneyActions.id, input.moneyActionId));

    const reason = `${input.allowReasonPrefix} and executed successfully.`;
    await logAuditEntry({
      merchantId: input.merchantId,
      actor: input.actor,
      event: "money_action_executed",
      decision: "allow",
      reason,
      boundApplied: `spend_cap_balance:${input.capId}`,
      moneyActionId: input.moneyActionId,
      metadata: { razorpayOrderId: order.id },
    });

    return { decision: "allow", reason, moneyActionId: input.moneyActionId, razorpayOrderId: order.id };
  } catch (executionErr) {
    // A failed payment must not consume the agent's cap or hold stock.
    await releaseBudget(input.capId, input.amountPaise);
    if (input.variantId) {
      await releaseStock(input.variantId, input.quantity ?? 1);
    }
    if (input.offerItems) {
      await releaseOfferStock(input.offerItems);
    }

    await db
      .update(schema.moneyActions)
      .set({ status: "failed" })
      .where(eq(schema.moneyActions.id, input.moneyActionId));

    const releasedWhat = input.variantId || input.offerItems ? "budget and stock" : "budget";
    const isRazorpayDecline = executionErr instanceof RazorpayCallError && executionErr.isRazorpayError;
    const reason = isRazorpayDecline
      ? `Execution failed — Razorpay rejected the order (${(executionErr as RazorpayCallError).razorpayCode}): ${executionErr instanceof Error ? executionErr.message : String(executionErr)}. Reserved ${releasedWhat} released.`
      : `Execution failed — ${executionErr instanceof Error ? executionErr.message : String(executionErr)}. Reserved ${releasedWhat} released.`;

    await logAuditEntry({
      merchantId: input.merchantId,
      actor: "system",
      event: "money_action_execution_failed",
      decision: "deny",
      reason,
      boundApplied: `spend_cap_balance:${input.capId}`,
      moneyActionId: input.moneyActionId,
    });

    return { decision: "deny", reason, moneyActionId: input.moneyActionId };
  }
}

/**
 * The single entry point for every money action. Runs the deterministic
 * checks, reserves budget atomically, executes against Razorpay, and
 * commits or releases the reservation, then always logs allow or deny.
 * Fails closed: any unexpected error results in a deny, never an allow.
 */
/** Reconstructs a GateResult from a previously-stored money_actions row, for idempotent replay. */
function resultFromExistingAction(
  action: typeof schema.moneyActions.$inferSelect,
): GateResult {
  const decision: GateDecision =
    action.status === "pending_escalation" ? "escalate" : action.status === "denied" || action.status === "failed" ? "deny" : "allow";

  return {
    decision,
    reason: `Idempotent replay — an action with this key already ${action.status === "executed" ? "executed" : action.status === "pending_escalation" ? "escalated" : "resolved"} (money_action ${action.id}). Returning the original outcome instead of reserving budget twice.`,
    moneyActionId: action.id,
    razorpayOrderId: action.razorpayEntityId ?? undefined,
  };
}

export async function attemptMoneyAction(
  request: MoneyActionRequest,
): Promise<GateResult> {
  try {
    if (request.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(schema.moneyActions)
        .where(
          and(
            eq(schema.moneyActions.agentId, request.agentId),
            eq(schema.moneyActions.idempotencyKey, request.idempotencyKey),
          ),
        );
      if (existing) {
        return resultFromExistingAction(existing);
      }
    }

    const boundsResult = await checkBounds(request);
    if (isBoundFailure(boundsResult)) {
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "agent",
        event: `money_action_attempt:${request.type}`,
        decision: "deny",
        reason: boundsResult.reason,
        boundApplied: boundsResult.boundApplied,
        metadata: { agentId: request.agentId, amountPaise: request.amountPaise, context: request.context, variantId: request.variantId },
      });
      return { decision: "deny", reason: boundsResult.reason };
    }
    const { variant, offer, negotiation, cart } = boundsResult;

    // Re-fetch rather than thread the cap through from checkBounds, so
    // the reservation's WHERE clause is the sole source of truth on balance.
    const [cap] = await db
      .select()
      .from(schema.spendCaps)
      .where(eq(schema.spendCaps.agentId, request.agentId))
      .orderBy(sql`${schema.spendCaps.createdAt} desc`)
      .limit(1);

    if (!cap) {
      // checkBounds already verified this exists, so getting here means
      // the cap was deleted between the check and now.
      const reason = "Denied — spend cap disappeared between check and reservation.";
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "agent",
        event: `money_action_attempt:${request.type}`,
        decision: "deny",
        reason,
        metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
      });
      return { decision: "deny", reason };
    }

    const reserved = await reserveBudget(cap.id, request.amountPaise);
    if (!reserved) {
      const reason = `Denied — another request consumed the remaining budget on spend cap ${cap.id} between check and reservation.`;
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "agent",
        event: `money_action_attempt:${request.type}`,
        decision: "deny",
        reason,
        boundApplied: `spend_cap_balance:${cap.id}`,
        metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
      });
      return { decision: "deny", reason };
    }

    const quantity = negotiation ? negotiation.quantity : (request.quantity ?? 1);
    if (variant) {
      const stockReserved = await reserveStock(variant.id, quantity);
      if (!stockReserved) {
        // Budget was already reserved above — give it back, same as any
        // other post-reservation failure.
        await releaseBudget(cap.id, request.amountPaise);
        const reason = `Denied — another request consumed the remaining stock for product ${variant.id} between check and reservation.`;
        await logAuditEntry({
          merchantId: request.merchantId,
          actor: "agent",
          event: `money_action_attempt:${request.type}`,
          decision: "deny",
          reason,
          boundApplied: "product_stock",
          metadata: { agentId: request.agentId, amountPaise: request.amountPaise, variantId: variant.id },
        });
        return { decision: "deny", reason };
      }
    }
    if (negotiation) {
      // Same single-variant reservation path as a plain variant purchase
      // — a negotiated price is one variant at a quantity, not a bundle,
      // so the all-or-nothing multi-item loop reserveOfferStock uses is
      // not needed here (plans/layer-8-negotiation.md, L8-1).
      const stockReserved = await reserveStock(negotiation.variantId, quantity);
      if (!stockReserved) {
        await releaseBudget(cap.id, request.amountPaise);
        const reason = `Denied — another request consumed the remaining stock for negotiation ${negotiation.negotiationId}'s variant between check and reservation.`;
        await logAuditEntry({
          merchantId: request.merchantId,
          actor: "agent",
          event: `money_action_attempt:${request.type}`,
          decision: "deny",
          reason,
          boundApplied: "negotiation_stock",
          metadata: { agentId: request.agentId, amountPaise: request.amountPaise, negotiationId: negotiation.negotiationId },
        });
        return { decision: "deny", reason };
      }
    }
    if (offer) {
      const stockReserved = await reserveOfferStock(offer.items);
      if (!stockReserved) {
        await releaseBudget(cap.id, request.amountPaise);
        const reason = `Denied — another request consumed the remaining stock for offer ${offer.offerId}'s bundle between check and reservation.`;
        await logAuditEntry({
          merchantId: request.merchantId,
          actor: "agent",
          event: `money_action_attempt:${request.type}`,
          decision: "deny",
          reason,
          boundApplied: "offer_bundle_stock",
          metadata: { agentId: request.agentId, amountPaise: request.amountPaise, offerId: offer.offerId },
        });
        return { decision: "deny", reason };
      }
    }
    // Frozen once stock is successfully reserved — money_actions.cartId
    // will point at this snapshot rather than the live (still-editable)
    // cart_items rows. See schema.ts's comment on cart_purchases.
    let cartPurchaseId: string | undefined;
    if (cart) {
      // Same all-or-nothing multi-item reservation an offer's bundle
      // uses — a cart is just an ad-hoc, buyer-authored set of variant
      // lines rather than a merchant-authored one.
      const stockReserved = await reserveOfferStock(cart.lines);
      if (!stockReserved) {
        await releaseBudget(cap.id, request.amountPaise);
        const reason = `Denied — another request consumed the remaining stock for an item in the cart between check and reservation.`;
        await logAuditEntry({
          merchantId: request.merchantId,
          actor: "agent",
          event: `money_action_attempt:${request.type}`,
          decision: "deny",
          reason,
          boundApplied: "cart_item_stock",
          metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
        });
        return { decision: "deny", reason };
      }
      cartPurchaseId = await snapshotCartPurchase(request.merchantId, cart);
    }

    // Budget (and stock, if a variant) is reserved. The risk layer runs next: it can only downgrade
    // this to pending_escalation, never turn a passed bound check into a
    // deny, since attemptMoneyAction only reaches here after every
    // deterministic check has already passed.
    const signals = await computeRiskSignals(request.agentId, request.amountPaise, cap);
    const risk = await assessRisk(signals, request.context);

    if (risk.decision === "escalate") {
      const { action: moneyAction, wasReplay } = await insertMoneyActionOrReplay(cap.id, {
        merchantId: request.merchantId,
        agentId: request.agentId,
        productId: variant?.productId,
        variantId: variant?.id ?? negotiation?.variantId,
        offerId: offer?.offerId,
        negotiationId: negotiation?.negotiationId,
        cartId: cartPurchaseId,
        quantity,
        type: request.type,
        amountPaise: request.amountPaise,
        status: "pending_escalation",
        idempotencyKey: request.idempotencyKey,
      });

      if (wasReplay) return resultFromExistingAction(moneyAction);

      await db.insert(schema.escalations).values({
        moneyActionId: moneyAction.id,
        spendCapId: cap.id,
        riskReason: risk.reason,
      });

      const reason = `Escalated — ${risk.reason} (assessed by ${risk.source}). Budget reserved and held pending merchant review.`;
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "system",
        event: `money_action_attempt:${request.type}`,
        decision: "escalate",
        reason,
        boundApplied: `spend_cap_balance:${cap.id}`,
        moneyActionId: moneyAction.id,
        metadata: { riskSource: risk.source, signals },
      });

      return { decision: "escalate", reason, moneyActionId: moneyAction.id };
    }

    // Record the money_actions row before executing, so a crash mid-call
    // still leaves a traceable "allowed" row rather than nothing at all.
    const { action: moneyAction, wasReplay } = await insertMoneyActionOrReplay(cap.id, {
      merchantId: request.merchantId,
      agentId: request.agentId,
      productId: variant?.productId,
      variantId: variant?.id ?? negotiation?.variantId,
      offerId: offer?.offerId,
      negotiationId: negotiation?.negotiationId,
      cartId: cartPurchaseId,
      quantity,
      holdOnly: request.holdOnly ?? false,
      type: request.type,
      amountPaise: request.amountPaise,
      status: "allowed",
      idempotencyKey: request.idempotencyKey,
    });

    if (wasReplay) return resultFromExistingAction(moneyAction);

    const allowReasonPrefix = request.rewardLedger
      ? `Allowed — ${request.rewardLedger.reason === "purchase_issue" ? "issuing" : "redeeming"} ₹${(request.amountPaise / 100).toFixed(2)} in reward coins is within this agent's remaining cap`
      : offer
        ? `Allowed — ₹${(request.amountPaise / 100).toFixed(2)} for offer ${offer.offerId}'s bundle is within this agent's remaining cap`
        : negotiation
          ? `Allowed — ₹${(request.amountPaise / 100).toFixed(2)} for negotiation ${negotiation.negotiationId}'s agreed price is within this agent's remaining cap`
          : cart
            ? `Allowed — ₹${(request.amountPaise / 100).toFixed(2)} for a ${cart.lines.length}-item cart is within this agent's remaining cap`
            : variant
              ? `Allowed — ₹${(request.amountPaise / 100).toFixed(2)} for "${request.context}" x${quantity} is within this agent's remaining cap`
              : `Allowed — ₹${(request.amountPaise / 100).toFixed(2)} for "${request.context}" is within this agent's remaining cap`;

    const result = await executeAndSettle({
      merchantId: request.merchantId,
      moneyActionId: moneyAction.id,
      capId: cap.id,
      amountPaise: request.amountPaise,
      context: request.context,
      agentId: request.agentId,
      actor: "agent",
      allowReasonPrefix,
      variantId: variant?.id ?? negotiation?.variantId,
      offerItems: offer?.items ?? cart?.lines,
      quantity,
      holdOnly: request.holdOnly ?? false,
      paymentLink: request.paymentLink,
      rewardLedger: request.rewardLedger,
    });

    // A negotiation is redeemed at most once — marking it here, only on a
    // genuine allow (never on a failure path, which leaves it "agreed"
    // so it can be retried), stops a second purchase attempt from
    // reusing the same agreed price after the first succeeds.
    if (negotiation && result.decision === "allow") {
      await markNegotiationRedeemed(negotiation.negotiationId);
    }

    return result;
  } catch (unexpectedErr) {
    // Fail closed: anything not already handled above still denies.
    const reason = `Denied — the gate could not evaluate this request: ${unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr)}.`;
    await logAuditEntry({
      merchantId: request.merchantId,
      actor: "system",
      event: `money_action_gate_error:${request.type}`,
      decision: "deny",
      reason,
      metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
    });
    return { decision: "deny", reason };
  }
}

/**
 * A merchant resolving a pending escalation. Approving executes the
 * held reservation exactly like a direct allow. Rejecting releases the
 * reservation without ever calling Razorpay. Both outcomes write an
 * audit entry, and both write to the escalations table so the dashboard
 * reflects a settled state.
 */
export async function resolveEscalation(
  merchantId: string,
  escalationId: string,
  outcome: "approved" | "rejected",
): Promise<GateResult> {
  const [escalation] = await db
    .select()
    .from(schema.escalations)
    .where(eq(schema.escalations.id, escalationId));

  if (!escalation) {
    throw new Error(`No escalation found with id ${escalationId}`);
  }

  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(eq(schema.moneyActions.id, escalation.moneyActionId));

  if (!moneyAction) {
    throw new Error(`Escalation ${escalationId} references a missing money action`);
  }

  // An escalation belongs to whichever merchant its money action belongs
  // to. Reject up front rather than let a merchant resolve another
  // merchant's escalation by guessing its id.
  if (moneyAction.merchantId !== merchantId) {
    throw new Error(`Escalation ${escalationId} does not belong to this merchant`);
  }

  // Conditional on outcome still being "pending" in the same statement,
  // so two concurrent resolutions of the same escalation can't both
  // proceed past this point. Whichever loses affects zero rows.
  const claimed = await db
    .update(schema.escalations)
    .set({ outcome, resolvedAt: new Date() })
    .where(and(eq(schema.escalations.id, escalationId), eq(schema.escalations.outcome, "pending")))
    .returning({ id: schema.escalations.id });

  if (claimed.length === 0) {
    throw new Error(`Escalation ${escalationId} was already resolved`);
  }

  if (outcome === "rejected") {
    await releaseBudget(escalation.spendCapId, moneyAction.amountPaise);
    if (moneyAction.variantId) {
      await releaseStock(moneyAction.variantId, moneyAction.quantity);
    }
    if (moneyAction.offerId) {
      await releaseOfferStock(await loadOfferItems(moneyAction.offerId));
    }
    if (moneyAction.cartId) {
      await releaseOfferStock(await loadCartPurchaseItems(moneyAction.cartId));
    }
    await db
      .update(schema.moneyActions)
      .set({ status: "failed" })
      .where(eq(schema.moneyActions.id, moneyAction.id));

    const releasedWhat = moneyAction.variantId || moneyAction.offerId || moneyAction.cartId ? "budget and stock" : "budget";
    const reason = `Rejected by merchant — ${escalation.riskReason} Reserved ${releasedWhat} released.`;
    await logAuditEntry({
      merchantId: moneyAction.merchantId,
      actor: "merchant",
      event: "escalation_resolved",
      decision: "deny",
      reason,
      boundApplied: `spend_cap_balance:${escalation.spendCapId}`,
      moneyActionId: moneyAction.id,
    });

    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }

  const approvedResult = await executeAndSettle({
    merchantId: moneyAction.merchantId,
    moneyActionId: moneyAction.id,
    capId: escalation.spendCapId,
    amountPaise: moneyAction.amountPaise,
    context: "merchant-approved escalation",
    agentId: moneyAction.agentId ?? "",
    actor: "merchant",
    allowReasonPrefix: `Approved by merchant — ₹${(moneyAction.amountPaise / 100).toFixed(2)} previously escalated (${escalation.riskReason})`,
    variantId: moneyAction.variantId ?? undefined,
    offerItems: moneyAction.offerId
      ? await loadOfferItems(moneyAction.offerId)
      : moneyAction.cartId
        ? await loadCartPurchaseItems(moneyAction.cartId)
        : undefined,
    quantity: moneyAction.quantity,
  });

  // A negotiated purchase that got escalated (plans/layer-8-negotiation.md,
  // fact 6) still needs its negotiation marked redeemed once the merchant
  // approves it — same discipline as attemptMoneyAction's direct-allow path.
  if (moneyAction.negotiationId && approvedResult.decision === "allow") {
    await markNegotiationRedeemed(moneyAction.negotiationId);
  }

  return approvedResult;
}

/** How long an escrow hold is allowed to sit unresolved before it's auto-refunded. See plans/layer-4-front-door.md's "a hold that is never resolved is money in limbo." */
export const ESCROW_HOLD_EXPIRY_HOURS = 48;

/**
 * Confirms a money action's payment actually settled, transitioning it
 * from "executed" (an order exists — an intent to collect) to either
 * "captured" (money genuinely arrived, the normal checkout path) or
 * "held" (authorised but not captured — the escrow flow, when the
 * originating request set holdOnly). Never reserves new budget or stock —
 * both were already committed when the order was created via
 * attemptMoneyAction; this only records the outcome of that already-
 * reserved action. Called from two independent, converging paths (Layer
 * 4-2's "fastest signal wins, only a verified one is written" contract):
 * the browser's post-checkout signature verification, and the
 * payment.captured/order.paid webhook. Idempotent: a second call against
 * an already-settled action is a no-op that still returns success, so
 * whichever signal arrives second doesn't double-log or error.
 */
export async function confirmCapture(
  moneyActionId: string,
  razorpayPaymentId: string,
  verifiedBy: "checkout_signature" | "webhook",
): Promise<GateResult> {
  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(eq(schema.moneyActions.id, moneyActionId));

  if (!moneyAction) {
    throw new Error(`No money action found with id ${moneyActionId}`);
  }

  if (moneyAction.status === "captured" || moneyAction.status === "held") {
    return {
      decision: "allow",
      reason: `Already ${moneyAction.status} (confirmed again via ${verifiedBy}, no change).`,
      moneyActionId: moneyAction.id,
      razorpayOrderId: moneyAction.razorpayEntityId ?? undefined,
    };
  }

  if (moneyAction.status !== "executed") {
    // A capture confirmation for an action that was never allowed, or
    // already failed, means the two signals disagree with what this
    // codebase itself recorded — fail closed rather than overwrite a
    // deny/failed status with a capture.
    const reason = `Denied — cannot confirm payment for money action ${moneyActionId}: its status is "${moneyAction.status}", not "executed".`;
    await logAuditEntry({
      merchantId: moneyAction.merchantId,
      actor: "system",
      event: "capture_confirmation_rejected",
      decision: "deny",
      reason,
      moneyActionId: moneyAction.id,
      metadata: { verifiedBy, razorpayPaymentId },
    });
    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }

  const targetStatus = moneyAction.holdOnly ? "held" : "captured";

  const claimed = await db
    .update(schema.moneyActions)
    .set({ status: targetStatus, razorpayPaymentId })
    .where(and(eq(schema.moneyActions.id, moneyActionId), eq(schema.moneyActions.status, "executed")))
    .returning({ id: schema.moneyActions.id });

  if (claimed.length === 0) {
    // Lost a race with the other verification path (webhook vs.
    // checkout signature landing at nearly the same time) — the other
    // one already settled it. Treat as success, not an error.
    return {
      decision: "allow",
      reason: `Already settled by a concurrent confirmation (this one via ${verifiedBy}).`,
      moneyActionId: moneyAction.id,
      razorpayOrderId: moneyAction.razorpayEntityId ?? undefined,
    };
  }

  if (targetStatus === "held") {
    // The bound that stops a hold from stranding a buyer's money
    // indefinitely — see plans/layer-4-front-door.md's L4-5 note. A
    // deterministic expiry, checked and swept by
    // recovery/escrow-sweep.ts, not a model decision.
    await db.insert(schema.escrowHolds).values({
      merchantId: moneyAction.merchantId,
      moneyActionId: moneyAction.id,
      outcome: "held",
      expiresAt: new Date(Date.now() + ESCROW_HOLD_EXPIRY_HOURS * 60 * 60 * 1000),
    });
  }

  const reason =
    targetStatus === "held"
      ? `Authorised and held — payment ${razorpayPaymentId} for order ${moneyAction.razorpayEntityId} verified via ${verifiedBy === "checkout_signature" ? "the checkout signature" : "the payment.captured webhook"}. Not captured — awaiting merchant release, refund, or auto-expiry after ${ESCROW_HOLD_EXPIRY_HOURS}h.`
      : `Captured — payment ${razorpayPaymentId} for order ${moneyAction.razorpayEntityId} verified via ${verifiedBy === "checkout_signature" ? "the checkout signature" : "the payment.captured webhook"}.`;

  await logAuditEntry({
    merchantId: moneyAction.merchantId,
    actor: "system",
    event: targetStatus === "held" ? "money_action_held" : "money_action_captured",
    decision: "allow",
    reason,
    moneyActionId: moneyAction.id,
    metadata: { verifiedBy, razorpayPaymentId },
  });

  return { decision: "allow", reason, moneyActionId: moneyAction.id, razorpayOrderId: moneyAction.razorpayEntityId ?? undefined };
}

/**
 * Captures a payment that was created with autoCapture: false and is
 * currently held (Layer 4-5's escrow flow). A real money action — moves
 * a held payment out of authorization into the merchant's account — so
 * it writes an audit entry the same as any other money action, but does
 * not reserve budget: the budget was already reserved and held since the
 * original order was created and gated. This is a settlement of an
 * existing reservation, not a new spend.
 */
export async function captureHeldPayment(
  merchantId: string,
  moneyActionId: string,
): Promise<GateResult> {
  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.id, moneyActionId), eq(schema.moneyActions.merchantId, merchantId)));

  if (!moneyAction) {
    throw new Error(`No money action found with id ${moneyActionId} for this merchant`);
  }

  if (moneyAction.status === "captured") {
    return {
      decision: "allow",
      reason: "Already captured, no change.",
      moneyActionId: moneyAction.id,
      razorpayOrderId: moneyAction.razorpayEntityId ?? undefined,
    };
  }

  if (moneyAction.status !== "held" || !moneyAction.razorpayPaymentId) {
    const reason = `Denied — money action ${moneyActionId} has no held payment to capture (status "${moneyAction.status}").`;
    await logAuditEntry({
      merchantId,
      actor: "merchant",
      event: "capture_denied",
      decision: "deny",
      reason,
      moneyActionId: moneyAction.id,
    });
    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }

  try {
    const credentials = await loadMerchantCredentials(merchantId);
    if (!credentials) throw new Error("Merchant's Razorpay account is no longer connected");

    await capturePayment(credentials, moneyAction.razorpayPaymentId, moneyAction.amountPaise);

    await db
      .update(schema.moneyActions)
      .set({ status: "captured" })
      .where(eq(schema.moneyActions.id, moneyActionId));

    await db
      .update(schema.escrowHolds)
      .set({ outcome: "captured", resolvedAt: new Date() })
      .where(eq(schema.escrowHolds.moneyActionId, moneyActionId));

    const reason = `Captured — held payment ${moneyAction.razorpayPaymentId} (₹${(moneyAction.amountPaise / 100).toFixed(2)}) released to the merchant's account.`;
    await logAuditEntry({
      merchantId,
      actor: "merchant",
      event: "money_action_captured",
      decision: "allow",
      reason,
      moneyActionId: moneyAction.id,
    });

    return { decision: "allow", reason, moneyActionId: moneyAction.id };
  } catch (err) {
    const reason = `Capture failed — ${err instanceof Error ? err.message : String(err)}.`;
    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "capture_failed",
      decision: "deny",
      reason,
      moneyActionId: moneyAction.id,
    });
    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }
}

/**
 * Refunds a captured (or held-and-authorised) payment, in full or in
 * part. A real money action moving value back out of the merchant's
 * account, so it writes an audit entry like any other. Releases the
 * corresponding budget and stock back, mirroring what a failed execution
 * releases — a refund is, from the spend cap's point of view, the same
 * "this money didn't end up spent" outcome.
 */
export async function issueRefund(
  merchantId: string,
  moneyActionId: string,
  amountPaise?: number,
): Promise<GateResult> {
  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.id, moneyActionId), eq(schema.moneyActions.merchantId, merchantId)));

  if (!moneyAction) {
    throw new Error(`No money action found with id ${moneyActionId} for this merchant`);
  }

  if ((moneyAction.status !== "captured" && moneyAction.status !== "held") || !moneyAction.razorpayPaymentId) {
    const reason = `Denied — money action ${moneyActionId} has no captured or held payment to refund (status "${moneyAction.status}").`;
    await logAuditEntry({
      merchantId,
      actor: "merchant",
      event: "refund_denied",
      decision: "deny",
      reason,
      moneyActionId: moneyAction.id,
    });
    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }

  const refundAmountPaise = amountPaise ?? moneyAction.amountPaise;
  if (refundAmountPaise > moneyAction.amountPaise) {
    const reason = `Denied — refund of ₹${(refundAmountPaise / 100).toFixed(2)} exceeds the original ₹${(moneyAction.amountPaise / 100).toFixed(2)} payment.`;
    await logAuditEntry({
      merchantId,
      actor: "merchant",
      event: "refund_denied",
      decision: "deny",
      reason,
      moneyActionId: moneyAction.id,
    });
    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }

  try {
    const credentials = await loadMerchantCredentials(merchantId);
    if (!credentials) throw new Error("Merchant's Razorpay account is no longer connected");

    const wasHeld = moneyAction.status === "held";
    const isFullRefund = refundAmountPaise === moneyAction.amountPaise;

    const refund = await refundPayment(credentials, moneyAction.razorpayPaymentId, refundAmountPaise);

    // Find the spend cap that was active when this action reserved
    // budget — the same lookup pattern checkBounds/reserveBudget use.
    // Only a full refund gives back the whole reservation; a partial
    // refund gives back only the refunded portion.
    if (moneyAction.agentId) {
      const [cap] = await db
        .select()
        .from(schema.spendCaps)
        .where(eq(schema.spendCaps.agentId, moneyAction.agentId))
        .orderBy(sql`${schema.spendCaps.createdAt} desc`)
        .limit(1);
      if (cap) await releaseBudget(cap.id, refundAmountPaise);
    }
    // Stock only comes back on a full refund — a partial refund is still
    // the same purchase, the buyer keeps what was bought.
    if (moneyAction.variantId && isFullRefund) {
      await releaseStock(moneyAction.variantId, moneyAction.quantity);
    }
    if (moneyAction.offerId && isFullRefund) {
      await releaseOfferStock(await loadOfferItems(moneyAction.offerId));
    }
    if (moneyAction.cartId && isFullRefund) {
      await releaseOfferStock(await loadCartPurchaseItems(moneyAction.cartId));
    }

    // A full refund means this action's money didn't end up spent —
    // same terminal state as a failed execution. A partial refund is
    // still a completed sale, just reduced, so it stays captured.
    if (isFullRefund) {
      await db.update(schema.moneyActions).set({ status: "failed" }).where(eq(schema.moneyActions.id, moneyActionId));
    }

    if (wasHeld) {
      await db
        .update(schema.escrowHolds)
        .set({ outcome: "refunded", resolvedAt: new Date() })
        .where(eq(schema.escrowHolds.moneyActionId, moneyActionId));
    }

    const releasedWhat = (moneyAction.variantId || moneyAction.offerId || moneyAction.cartId) && isFullRefund ? "budget and stock" : "budget";
    const reason = `Refunded — ₹${(refundAmountPaise / 100).toFixed(2)} of ₹${(moneyAction.amountPaise / 100).toFixed(2)} (refund ${refund.id}). ${isFullRefund ? `Full refund — reserved ${releasedWhat} released.` : "Partial refund — the sale stands, reduced by the refunded amount."}`;
    await logAuditEntry({
      merchantId,
      actor: "merchant",
      event: "money_action_refunded",
      decision: "n/a",
      reason,
      moneyActionId: moneyAction.id,
      metadata: { refundId: refund.id, refundAmountPaise, wasHeld },
    });

    return { decision: "allow", reason, moneyActionId: moneyAction.id };
  } catch (err) {
    const reason = `Refund failed — ${err instanceof Error ? err.message : String(err)}.`;
    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "refund_failed",
      decision: "deny",
      reason,
      moneyActionId: moneyAction.id,
    });
    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }
}
