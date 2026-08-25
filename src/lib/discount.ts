import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * The only place a discounted price is computed (Layer 6-1). The gate's
 * product_price_match bound denies any request where amountPaise doesn't
 * match the catalogue price exactly — this module is what lets a real,
 * merchant-authored discount pass that bound without weakening it: a
 * caller may reference an offer by id, but the amount it must pay is
 * re-derived here from the merchant's own bundle row, never trusted from
 * the request. See DECISIONS.md, "How a discount is represented."
 *
 * A bundle's price is a merchant-set integer paise total — never a
 * percent recomputed at read time, so there is exactly one number an
 * offer can ever resolve to.
 */

export interface ResolvedOffer {
  offerId: string;
  bundleId: string;
  amountPaise: number;
  /** The variant/quantity pairs the buyer receives for amountPaise. */
  items: { variantId: string; quantity: number }[];
}

export interface OfferResolutionFailure {
  reason: string;
  boundApplied: string;
}

/**
 * Resolves an offerId into the amount the gate must charge, re-checking
 * every bound deterministically: the offer exists, belongs to this
 * merchant, was actually accepted (not just offered or already
 * declined/expired), hasn't passed its expiry, and the identity
 * attempting to redeem it (agent or session) matches who it was made to.
 * Returns a failure with a specific boundApplied on any mismatch — same
 * pattern as gate.ts's resolveVariant.
 */
export async function resolveOffer(
  merchantId: string,
  offerId: string,
  redeemer: { agentId?: string; sessionToken?: string },
): Promise<{ offer?: ResolvedOffer; failure?: OfferResolutionFailure }> {
  const [offer] = await db.select().from(schema.offers).where(eq(schema.offers.id, offerId));

  if (!offer || offer.merchantId !== merchantId) {
    return { failure: { reason: `Denied — no offer ${offerId} found for this merchant.`, boundApplied: "offer_exists" } };
  }

  if (offer.status !== "accepted") {
    return {
      failure: {
        reason: `Denied — offer ${offerId} is "${offer.status}", not accepted. Only an offer the buyer has explicitly accepted can be redeemed.`,
        boundApplied: `offer_status:${offer.id}`,
      },
    };
  }

  const now = new Date();
  if (now > offer.expiresAt) {
    return {
      failure: {
        reason: `Denied — offer ${offerId} expired at ${offer.expiresAt.toISOString()}.`,
        boundApplied: `offer_expiry:${offer.id}`,
      },
    };
  }

  const identityMatches = offer.agentId
    ? offer.agentId === redeemer.agentId
    : offer.sessionToken === redeemer.sessionToken;
  if (!identityMatches) {
    return {
      failure: {
        reason: `Denied — offer ${offerId} was made to a different buyer.`,
        boundApplied: `offer_identity:${offer.id}`,
      },
    };
  }

  const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, offer.bundleId));
  if (!bundle || bundle.merchantId !== merchantId || bundle.status !== "active") {
    return {
      failure: {
        reason: `Denied — offer ${offerId}'s bundle is no longer active.`,
        boundApplied: `bundle_status:${offer.bundleId}`,
      },
    };
  }

  const items = await db.select().from(schema.bundleItems).where(eq(schema.bundleItems.bundleId, bundle.id));

  return {
    offer: {
      offerId: offer.id,
      bundleId: bundle.id,
      amountPaise: bundle.bundlePricePaise,
      items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
    },
  };
}

/**
 * Marks an offer accepted. Only a buyer can accept their own offer, and
 * only one still in the "offered" state — the conditional UPDATE means
 * a double-click or a race lands exactly one acceptance, same pattern as
 * spend_caps/product_variants' atomic reservations.
 */
export async function acceptOffer(
  merchantId: string,
  offerId: string,
  redeemer: { agentId?: string; sessionToken?: string },
): Promise<boolean> {
  const claimed = await db
    .update(schema.offers)
    .set({ status: "accepted", resolvedAt: new Date() })
    .where(
      and(
        eq(schema.offers.id, offerId),
        eq(schema.offers.merchantId, merchantId),
        eq(schema.offers.status, "offered"),
        redeemer.agentId ? eq(schema.offers.agentId, redeemer.agentId) : eq(schema.offers.sessionToken, redeemer.sessionToken ?? ""),
      ),
    )
    .returning({ id: schema.offers.id });

  return claimed.length > 0;
}

/** Marks an offer declined. Same conditional-update discipline as acceptOffer. */
export async function declineOffer(
  merchantId: string,
  offerId: string,
  redeemer: { agentId?: string; sessionToken?: string },
): Promise<boolean> {
  const claimed = await db
    .update(schema.offers)
    .set({ status: "declined", resolvedAt: new Date() })
    .where(
      and(
        eq(schema.offers.id, offerId),
        eq(schema.offers.merchantId, merchantId),
        eq(schema.offers.status, "offered"),
        redeemer.agentId ? eq(schema.offers.agentId, redeemer.agentId) : eq(schema.offers.sessionToken, redeemer.sessionToken ?? ""),
      ),
    )
    .returning({ id: schema.offers.id });

  return claimed.length > 0;
}

/**
 * Loads an offer's bundle items by offer id, for the two gate paths that
 * need to release stock against an already-settled offer purchase
 * (an escalation rejection, a refund) without re-running every identity
 * and expiry check resolveOffer does at attempt time.
 */
export async function loadOfferItems(offerId: string): Promise<ResolvedOffer["items"]> {
  const [offer] = await db.select().from(schema.offers).where(eq(schema.offers.id, offerId));
  if (!offer) return [];
  const items = await db.select().from(schema.bundleItems).where(eq(schema.bundleItems.bundleId, offer.bundleId));
  return items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
}

/** Sweeps offers whose deterministic expiry has passed into "expired", so a stale row never gets redeemed. Mirrors escrow.ts's sweepExpiredHolds. */
export async function sweepExpiredOffers(): Promise<number> {
  const result = await db
    .update(schema.offers)
    .set({ status: "expired", resolvedAt: new Date() })
    .where(and(eq(schema.offers.status, "offered"), sql`${schema.offers.expiresAt} < now()`))
    .returning({ id: schema.offers.id });

  return result.length;
}
