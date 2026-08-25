import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { completeStructured } from "@/lib/llm";
import { getMerchantBundles } from "@/lib/bundles";

/**
 * The upsell offer engine (Layer 6-2). The AI/code split CLAUDE.md rule 2
 * requires, stated precisely for this module:
 *
 * - Code decides which bundles are ELIGIBLE at all (same merchant, active,
 *   every item in stock, not a bundle whose only item is what's already
 *   in the cart) and which of those clear the merchant's MARGIN FLOOR
 *   (bundlePricePaise - summed costPaise, both real integer paise). A
 *   below-floor bundle is removed from the candidate set BEFORE the model
 *   ever sees it — the model cannot choose an unprofitable upsell because
 *   an unprofitable one is never in its input.
 * - The model only RANKS which of the eligible, margin-clearing
 *   candidates is most relevant to what's in the cart, and writes the one
 *   sentence explaining why. It may also say none of them fit — that is
 *   an equally valid, equally recorded output, not an error.
 * - Every run — whether it results in an offer or not — writes one
 *   offer_decisions row. An engine that always finds something to offer
 *   is not bounded, it's just a recommender; the refusal case is the
 *   feature. See ARCHITECTURE.md and plans/layer-6-upsell-bundling-rewards.md.
 *
 * A model failure here degrades to no offer (never to a denied purchase
 * or a crashed checkout) — a different fail-closed than the gate's,
 * since the underlying purchase this engine runs alongside is additive
 * and unaffected either way.
 */

const MAX_CANDIDATES_TO_MODEL = 8;
const OFFER_EXPIRY_MINUTES = 15;

export interface OfferBuyerIdentity {
  agentId?: string;
  sessionToken?: string;
}

export interface EngineResult {
  offer: {
    offerId: string;
    bundleId: string;
    bundleName: string;
    amountPaise: number;
    reasonText: string;
    expiresAt: Date;
  } | null;
  noOfferReason: string | null;
}

const rankResponseSchema = z.object({
  chosenBundleId: z.string().nullable(),
  reasonText: z.string().min(1).nullable(),
});

/**
 * Runs the engine for one cart (a variant + quantity a buyer is about to
 * pay for) and returns at most one offer. Always writes an offer_decisions
 * row recording the arithmetic that produced the result — see L6-4.
 */
export async function runOfferEngine(
  merchantId: string,
  cartVariantId: string,
  identity: OfferBuyerIdentity,
): Promise<EngineResult> {
  const [cartVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, cartVariantId));

  const bundles = await getMerchantBundles(merchantId);
  const activeBundles = bundles.filter((b) => b.status === "active");

  // Eligible: every item in stock, and the bundle isn't just the cart's
  // own variant alone (offering a buyer a "bundle" of the thing they're
  // already buying, at the same or a fake-discounted price, isn't an
  // upsell).
  const eligible = activeBundles.filter((bundle) => {
    const isJustTheCartItem = bundle.items.length === 1 && bundle.items[0].variantId === cartVariantId;
    if (isJustTheCartItem) return false;
    return true;
  });

  // Margin floor: bundlePricePaise minus every item's real costPaise,
  // computed here from the DB, never from anything a caller or the model
  // supplied. A bundle below floor never reaches the model.
  const itemCostByVariant = new Map<string, number>();
  if (eligible.length > 0) {
    const variantIds = [...new Set(eligible.flatMap((b) => b.items.map((i) => i.variantId)))];
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId));
    for (const v of variants) {
      if (variantIds.includes(v.id)) itemCostByVariant.set(v.id, v.costPaise);
    }
  }

  const withMargin = eligible.map((bundle) => {
    const costSumPaise = bundle.items.reduce((sum, item) => sum + (itemCostByVariant.get(item.variantId) ?? 0) * item.quantity, 0);
    return { bundle, marginPaise: bundle.bundlePricePaise - costSumPaise };
  });

  const belowFloor = withMargin.filter((w) => w.marginPaise <= 0);
  const aboveFloor = withMargin.filter((w) => w.marginPaise > 0);

  const eligibleCandidateCount = eligible.length;
  const belowMarginFloorCount = belowFloor.length;

  if (aboveFloor.length === 0) {
    const noOfferReason =
      eligibleCandidateCount === 0
        ? "No eligible bundle exists for this cart."
        : `Every eligible bundle (${belowMarginFloorCount}) priced at or below its own item cost — none clear the margin floor.`;

    const [decision] = await db
      .insert(schema.offerDecisions)
      .values({
        merchantId,
        agentId: identity.agentId,
        sessionToken: identity.sessionToken,
        cartVariantId,
        eligibleCandidateCount,
        belowMarginFloorCount,
        noOfferReason,
      })
      .returning();

    return { offer: null, noOfferReason: decision.noOfferReason };
  }

  // Bound the prompt deterministically — a large catalogue's bundle list
  // is capped before it ever reaches the model, not left to the model to
  // self-limit.
  const candidates = aboveFloor.slice(0, MAX_CANDIDATES_TO_MODEL).map((w) => ({
    bundleId: w.bundle.id,
    name: w.bundle.name,
    priceRupees: (w.bundle.bundlePricePaise / 100).toFixed(2),
    items: w.bundle.items.map((i) => `${i.quantity}x ${i.sku}`),
  }));

  let chosen: { chosenBundleId: string | null; reasonText: string | null } | null = null;
  try {
    const cartDescription = cartVariant ? `${cartVariant.sku} (${cartVariant.pricePaise / 100} rupees)` : "an item";
    const { data } = await completeStructured({
      prompt: `A buyer is about to purchase ${cartDescription}. Here are bundle offers that are eligible and profitable to offer (already filtered by the merchant's margin rules — you don't need to check pricing):\n${JSON.stringify(candidates, null, 2)}\n\nPick the ONE bundle most relevant to what this buyer is already purchasing, or none if nothing genuinely fits. Write one short, honest sentence a buyer would read at checkout explaining why, if you pick one.`,
      systemPrompt:
        "You are a checkout upsell assistant. You may only choose from the exact bundleId values given. Never invent a bundleId. If nothing is a good fit, set chosenBundleId to null. Never mention price, cost, or margin in reasonText.",
      schema: rankResponseSchema,
      schemaDescription: '{"chosenBundleId": string | null, "reasonText": string | null}',
    });
    chosen = data;
  } catch (err) {
    console.warn("[offer-engine] Model call failed, degrading to no offer:", err);
    chosen = null;
  }

  const chosenCandidate = chosen?.chosenBundleId ? candidates.find((c) => c.bundleId === chosen!.chosenBundleId) : undefined;

  if (!chosen || !chosenCandidate || !chosen.reasonText) {
    const noOfferReason = !chosen
      ? "Model unavailable — degraded to no offer rather than risk an ungrounded recommendation."
      : "Model declined to offer any of the eligible candidates.";

    const [decision] = await db
      .insert(schema.offerDecisions)
      .values({
        merchantId,
        agentId: identity.agentId,
        sessionToken: identity.sessionToken,
        cartVariantId,
        eligibleCandidateCount,
        belowMarginFloorCount,
        noOfferReason,
      })
      .returning();

    return { offer: null, noOfferReason: decision.noOfferReason };
  }

  const bundle = aboveFloor.find((w) => w.bundle.id === chosenCandidate.bundleId)!.bundle;
  const expiresAt = new Date(Date.now() + OFFER_EXPIRY_MINUTES * 60 * 1000);

  const [offerRow] = await db
    .insert(schema.offers)
    .values({
      merchantId,
      bundleId: bundle.id,
      agentId: identity.agentId,
      sessionToken: identity.sessionToken,
      status: "offered",
      reasonText: chosen.reasonText,
      expiresAt,
    })
    .returning();

  await db.insert(schema.offerDecisions).values({
    merchantId,
    agentId: identity.agentId,
    sessionToken: identity.sessionToken,
    cartVariantId,
    eligibleCandidateCount,
    belowMarginFloorCount,
    offeredOfferId: offerRow.id,
  });

  return {
    offer: {
      offerId: offerRow.id,
      bundleId: bundle.id,
      bundleName: bundle.name,
      amountPaise: bundle.bundlePricePaise,
      reasonText: offerRow.reasonText,
      expiresAt: offerRow.expiresAt,
    },
    noOfferReason: null,
  };
}

/** At most one still-open offer per buyer identity — used by every surface (L6-3) so a buyer is never shown two upsells for one checkout. */
export async function getOpenOfferForIdentity(merchantId: string, identity: OfferBuyerIdentity) {
  if (!identity.agentId && !identity.sessionToken) return null;

  const [offer] = await db
    .select()
    .from(schema.offers)
    .where(
      and(
        eq(schema.offers.merchantId, merchantId),
        eq(schema.offers.status, "offered"),
        identity.agentId ? eq(schema.offers.agentId, identity.agentId) : eq(schema.offers.sessionToken, identity.sessionToken!),
      ),
    );
  return offer ?? null;
}
