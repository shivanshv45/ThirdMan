import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { completeStructured } from "@/lib/llm";
import { z } from "zod";

/**
 * Bounded autonomous negotiation (Layer 8). The AI/code split CLAUDE.md
 * rule 2 requires, stated precisely for this module — see plans/
 * layer-8-negotiation.md, "The one rule": a model may argue, only code
 * may agree.
 *
 * - Code decides whether a variant is negotiable at all (a floor is set,
 *   the variant is active and in stock).
 * - Code decides whether a buyer's counter is acceptable — a pure
 *   integer comparison against the floor. Never a model.
 * - Code computes the concession schedule deterministically from the
 *   standing price, the floor, the turn number, and the minimum step —
 *   the same category as recovery/policy.ts's backoff schedule, zero
 *   model calls by design.
 * - The model chooses only the words, within a range code already
 *   computed and floor-safe. Its chosen number is re-checked and clamped
 *   in code afterward — the prompt is not the enforcement, the post-check
 *   is.
 * - The model NEVER receives the floor, the cost, or the margin. Only the
 *   catalogue price, the buyer's counter, the turn number/budget, and the
 *   code-computed allowed range it may propose within.
 * - A model failure degrades to the deterministic counter — a plain,
 *   templated sentence at the code-computed concession price. Never a
 *   crash, never accepting the buyer's price, never a wider range. A
 *   fourth fail-closed flavour in this codebase, alongside the gate's
 *   (deny), the offer engine's (no offer), and the explainer's (raw
 *   record): here, closed means the deterministic counter, or a refusal.
 * - A refusal (floor breach, turn budget exhausted, expiry) is a
 *   first-class recorded outcome with the exact arithmetic, never a
 *   silent early return — offer_decisions' contract, restated.
 */

// Named exported constants, not magic numbers — a merchant-configurable
// version later is a change of source, not a rewrite.
export const MAX_BUYER_COUNTERS = 3;
export const NEGOTIATION_EXPIRY_MINUTES = 20;
/** The smallest per-unit concession step, in paise, so the model can't be walked down in ₹1 increments across the turn budget. */
export const MIN_CONCESSION_STEP_PAISE = 100;

export interface NegotiationBuyerIdentity {
  agentId?: string;
  sessionToken?: string;
}

export interface OpenNegotiationResult {
  negotiation?: typeof schema.negotiations.$inferSelect;
  refusalReason?: string;
}

/**
 * Opens a negotiation on one variant/quantity for one buyer identity, if
 * the variant is negotiable at all. Deterministic — no model call. Denied
 * outright (never opened) if: the variant has no floor set, is inactive
 * or out of stock, or this identity already has an open negotiation on
 * this variant (getOpenOfferForIdentity's precedent — never two
 * simultaneous negotiations on the same thing).
 */
export async function openNegotiation(
  merchantId: string,
  variantId: string,
  quantity: number,
  identity: NegotiationBuyerIdentity,
): Promise<OpenNegotiationResult> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { refusalReason: `Quantity ${quantity} is not a positive integer.` };
  }

  const [variant] = await db
    .select()
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, variantId));

  if (!variant || variant.merchantId !== merchantId) {
    return { refusalReason: `No product ${variantId} found for this merchant.` };
  }

  if (variant.status !== "active") {
    return { refusalReason: `"${variant.sku}" is ${variant.status}, not active.` };
  }

  if (variant.floorPricePaise === null) {
    return { refusalReason: `"${variant.sku}" is not negotiable — the merchant has not set a floor price for it.` };
  }

  if (variant.stock < quantity) {
    return { refusalReason: `"${variant.sku}" has ${variant.stock} in stock, but ${quantity} were requested.` };
  }

  const existing = await getOpenNegotiationForIdentity(merchantId, variantId, identity);
  if (existing) {
    return { refusalReason: `A negotiation on "${variant.sku}" is already open for this buyer. Continue it instead of opening a new one.` };
  }

  const expiresAt = new Date(Date.now() + NEGOTIATION_EXPIRY_MINUTES * 60 * 1000);

  const [negotiation] = await db
    .insert(schema.negotiations)
    .values({
      merchantId,
      variantId,
      quantity,
      agentId: identity.agentId,
      sessionToken: identity.sessionToken,
      status: "open",
      catalogueUnitPricePaise: variant.pricePaise,
      floorUnitPricePaise: variant.floorPricePaise,
      expiresAt,
    })
    .returning();

  return { negotiation };
}

/** At most one open negotiation per buyer identity per variant — mirrors offer-engine.ts's getOpenOfferForIdentity. */
export async function getOpenNegotiationForIdentity(
  merchantId: string,
  variantId: string,
  identity: NegotiationBuyerIdentity,
) {
  if (!identity.agentId && !identity.sessionToken) return null;

  const [negotiation] = await db
    .select()
    .from(schema.negotiations)
    .where(
      and(
        eq(schema.negotiations.merchantId, merchantId),
        eq(schema.negotiations.variantId, variantId),
        eq(schema.negotiations.status, "open"),
        identity.agentId ? eq(schema.negotiations.agentId, identity.agentId) : eq(schema.negotiations.sessionToken, identity.sessionToken!),
      ),
    );
  return negotiation ?? null;
}

/**
 * The deterministic concession schedule: given the current standing
 * merchant price, the floor, and which buyer-counter turn this is,
 * computes the exact price code will let the model (or the deterministic
 * degrade path) propose this turn. Only ever called for turns 1 through
 * MAX_BUYER_COUNTERS - 1 — the final turn (MAX_BUYER_COUNTERS) is a
 * refusal, not a counter, so this schedule never needs to reach the
 * floor exactly; it concedes the remaining gap evenly across the turns
 * still available, biasing toward the floor as the budget runs down.
 * Never concedes less than MIN_CONCESSION_STEP_PAISE in a single step.
 * Pure arithmetic — no I/O, no model.
 */
function computeConcessionCeiling(
  standingMerchantPricePaise: number,
  floorPaise: number,
  turnNumber: number,
): number {
  const gap = standingMerchantPricePaise - floorPaise;
  if (gap <= 0) return floorPaise;

  const turnsRemaining = Math.max(MAX_BUYER_COUNTERS - turnNumber + 1, 1);
  const concession = Math.max(MIN_CONCESSION_STEP_PAISE, Math.ceil(gap / turnsRemaining));
  const proposed = standingMerchantPricePaise - concession;
  return Math.max(proposed, floorPaise);
}

const counterResponseSchema = z.object({
  message: z.string().min(1),
});

/**
 * Records one buyer counter-offer and produces the merchant agent's
 * response — either an agreement, a further counter, or a refusal. This
 * is the engine's only entry point once a negotiation is open.
 *
 * The buyer's counter is checked against the floor in code BEFORE any
 * model call: at or above the floor, code may agree immediately without
 * needing a counter round at all. Below the floor, code computes the
 * exact price the merchant's agent will counter at this turn
 * (computeConcessionCeiling) and only then asks the model to phrase that
 * already-decided number as a sentence — the model never sees the floor,
 * the cost, or the margin, and is never asked to choose a price at all
 * (see the module docstring's "one rule"). `counterPricePaise` is
 * reassigned from `ceiling` unconditionally after the model call, so
 * nothing in the model's response — not even a garbage or adversarial
 * one — can ever influence the number a buyer is offered.
 */
export async function submitBuyerCounter(
  negotiationId: string,
  merchantId: string,
  identity: NegotiationBuyerIdentity,
  buyerUnitPricePaise: number,
): Promise<{
  negotiation: typeof schema.negotiations.$inferSelect;
  outcome: "agreed" | "countered" | "refused";
  message: string;
}> {
  const [negotiation] = await db
    .select()
    .from(schema.negotiations)
    .where(eq(schema.negotiations.id, negotiationId));

  if (!negotiation || negotiation.merchantId !== merchantId) {
    throw new Error(`No negotiation ${negotiationId} found for this merchant`);
  }

  const identityMatches = negotiation.agentId ? negotiation.agentId === identity.agentId : negotiation.sessionToken === identity.sessionToken;
  if (!identityMatches) {
    throw new Error(`Negotiation ${negotiationId} belongs to a different buyer`);
  }

  if (negotiation.status !== "open") {
    throw new Error(`Negotiation ${negotiationId} is "${negotiation.status}", not open`);
  }

  if (!Number.isInteger(buyerUnitPricePaise) || buyerUnitPricePaise <= 0) {
    throw new Error(`Buyer counter ${buyerUnitPricePaise} is not a positive integer number of paise`);
  }

  const now = new Date();
  if (now > negotiation.expiresAt) {
    const [expired] = await db
      .update(schema.negotiations)
      .set({ status: "expired", resolvedAt: now })
      .where(eq(schema.negotiations.id, negotiationId))
      .returning();
    const message = `This negotiation expired at ${negotiation.expiresAt.toISOString()}. Start a new one to continue.`;
    await db.insert(schema.negotiationTurns).values({ negotiationId, speaker: "merchant_agent", message });
    return { negotiation: expired, outcome: "refused", message };
  }

  const nextTurnCount = negotiation.buyerTurnCount + 1;

  await db.insert(schema.negotiationTurns).values({
    negotiationId,
    speaker: "buyer",
    offeredUnitPricePaise: buyerUnitPricePaise,
    message: `Buyer offered ₹${(buyerUnitPricePaise / 100).toFixed(2)} per unit.`,
  });

  // At or above the floor: code agrees immediately. No model call
  // needed — accepting a price that already clears the floor is
  // arithmetic, not judgment.
  if (buyerUnitPricePaise >= negotiation.floorUnitPricePaise) {
    const message = `Agreed at ₹${(buyerUnitPricePaise / 100).toFixed(2)} per unit.`;
    const [agreed] = await db
      .update(schema.negotiations)
      .set({
        status: "agreed",
        buyerTurnCount: nextTurnCount,
        currentBuyerOfferPaise: buyerUnitPricePaise,
        agreedUnitPricePaise: buyerUnitPricePaise,
        resolvedAt: now,
      })
      .where(eq(schema.negotiations.id, negotiationId))
      .returning();
    await db.insert(schema.negotiationTurns).values({
      negotiationId,
      speaker: "merchant_agent",
      offeredUnitPricePaise: buyerUnitPricePaise,
      message,
    });
    return { negotiation: agreed, outcome: "agreed", message };
  }

  // Below the floor: exhausting the turn budget is a deterministic
  // refusal, checked before any model call — the anti-probing bound
  // (plans/layer-8-negotiation.md, fact 2). The buyer's MAX_BUYER_COUNTERS-th
  // counter is itself the last one allowed — >= here, not >, so a buyer
  // genuinely gets at most MAX_BUYER_COUNTERS counters total rather than
  // one extra "courtesy" round past the stated limit (a real off-by-one
  // caught by negotiation.test.ts's own turn-budget test before this
  // shipped — see FAILURES.md).
  if (nextTurnCount >= MAX_BUYER_COUNTERS) {
    const message = `Denied — after ${nextTurnCount} counter-offers, no agreement was reached within this negotiation's turn limit of ${MAX_BUYER_COUNTERS}. The lowest this store's agent can go is not being disclosed further.`;
    const [refused] = await db
      .update(schema.negotiations)
      .set({ status: "refused_turns_exhausted", buyerTurnCount: nextTurnCount, currentBuyerOfferPaise: buyerUnitPricePaise, resolvedAt: now })
      .where(eq(schema.negotiations.id, negotiationId))
      .returning();
    await db.insert(schema.negotiationTurns).values({ negotiationId, speaker: "merchant_agent", message });
    return { negotiation: refused, outcome: "refused", message };
  }

  // Compute the deterministic counter ceiling — the highest price code
  // will let the model (or the degrade path) propose this turn. The
  // standing merchant price is the previous counter, or the catalogue
  // price on the buyer's first offer.
  const standingPrice = negotiation.currentMerchantCounterPaise ?? negotiation.catalogueUnitPricePaise;
  const ceiling = computeConcessionCeiling(standingPrice, negotiation.floorUnitPricePaise, nextTurnCount);

  let counterPricePaise = ceiling;
  let modelMessage: string | null = null;

  try {
    const { data } = await completeStructured({
      prompt: `A buyer is negotiating the price of one unit of a product, currently listed at ₹${(negotiation.catalogueUnitPricePaise / 100).toFixed(2)}. The buyer just offered ₹${(buyerUnitPricePaise / 100).toFixed(2)} per unit. This is counter-offer round ${nextTurnCount} of ${MAX_BUYER_COUNTERS}.\n\nYou (the merchant's agent) will counter at exactly ₹${(ceiling / 100).toFixed(2)} per unit — this number is already decided and final, you may not change it. Write one short, friendly sentence proposing this exact price to the buyer. Do not mention margins, costs, or any other number.`,
      systemPrompt:
        "You are a merchant's checkout negotiation assistant. You never decide a price — one has already been decided for you and given to you exactly. Your only job is to phrase it as a natural counter-offer sentence. Never invent a different number.",
      schema: counterResponseSchema,
      schemaDescription: '{"message": string}',
    });
    modelMessage = data.message;
  } catch (err) {
    console.warn("[negotiation] Model call failed, degrading to deterministic counter:", err);
    modelMessage = null;
  }

  // The model's job was words only, but re-derive the counter price from
  // code regardless of what came back — there is no path by which a
  // model output can move counterPricePaise away from `ceiling`, since
  // it was never asked for a price and nothing above assigns from its
  // response. This is the concrete guarantee, not just a comment: even a
  // fully adversarial model response cannot change counterPricePaise.
  counterPricePaise = ceiling;

  const message = modelMessage ?? `We can offer ₹${(counterPricePaise / 100).toFixed(2)} per unit.`;

  const [countered] = await db
    .update(schema.negotiations)
    .set({
      buyerTurnCount: nextTurnCount,
      currentBuyerOfferPaise: buyerUnitPricePaise,
      currentMerchantCounterPaise: counterPricePaise,
    })
    .where(eq(schema.negotiations.id, negotiationId))
    .returning();

  await db.insert(schema.negotiationTurns).values({
    negotiationId,
    speaker: "merchant_agent",
    offeredUnitPricePaise: counterPricePaise,
    message,
  });

  return { negotiation: countered, outcome: "countered", message };
}

export interface ResolvedNegotiation {
  negotiationId: string;
  variantId: string;
  quantity: number;
  unitPricePaise: number;
  amountPaise: number;
}

export interface NegotiationResolutionFailure {
  reason: string;
  boundApplied: string;
}

/**
 * Resolves a negotiationId into what the gate must charge, re-deriving
 * the amount independently of anything the caller asserted — the same
 * contract discount.ts's resolveOffer already proves. Denies on
 * non-existence, wrong merchant, wrong buyer identity, not-agreed status,
 * or expiry, each with its own specific boundApplied string.
 */
export async function resolveNegotiation(
  merchantId: string,
  negotiationId: string,
  redeemer: { agentId?: string; sessionToken?: string },
): Promise<{ resolved?: ResolvedNegotiation; failure?: NegotiationResolutionFailure }> {
  const [negotiation] = await db.select().from(schema.negotiations).where(eq(schema.negotiations.id, negotiationId));

  if (!negotiation || negotiation.merchantId !== merchantId) {
    return { failure: { reason: `Denied — no negotiation ${negotiationId} found for this merchant.`, boundApplied: "negotiation_exists" } };
  }

  if (negotiation.status !== "agreed") {
    return {
      failure: {
        reason: `Denied — negotiation ${negotiationId} is "${negotiation.status}", not agreed. Only an agreed negotiation can be redeemed.`,
        boundApplied: `negotiation_status:${negotiation.id}`,
      },
    };
  }

  const now = new Date();
  if (now > negotiation.expiresAt) {
    return {
      failure: {
        reason: `Denied — negotiation ${negotiationId} expired at ${negotiation.expiresAt.toISOString()}.`,
        boundApplied: `negotiation_expiry:${negotiation.id}`,
      },
    };
  }

  const identityMatches = negotiation.agentId ? negotiation.agentId === redeemer.agentId : negotiation.sessionToken === redeemer.sessionToken;
  if (!identityMatches) {
    return {
      failure: { reason: `Denied — negotiation ${negotiationId} was made to a different buyer.`, boundApplied: `negotiation_identity:${negotiation.id}` },
    };
  }

  return {
    resolved: {
      negotiationId: negotiation.id,
      variantId: negotiation.variantId,
      quantity: negotiation.quantity,
      unitPricePaise: negotiation.agreedUnitPricePaise!,
      amountPaise: negotiation.agreedUnitPricePaise! * negotiation.quantity,
    },
  };
}

/** Marks a negotiation redeemed, so it can't be replayed by a second purchase attempt. Called by the gate after a successful purchase. */
export async function markNegotiationRedeemed(negotiationId: string): Promise<void> {
  await db
    .update(schema.negotiations)
    .set({ status: "redeemed", resolvedAt: new Date() })
    .where(and(eq(schema.negotiations.id, negotiationId), eq(schema.negotiations.status, "agreed")));
}

/** Every turn of a negotiation, oldest first — the transcript a merchant reads. */
export async function getNegotiationTranscript(negotiationId: string) {
  return db
    .select()
    .from(schema.negotiationTurns)
    .where(eq(schema.negotiationTurns.negotiationId, negotiationId))
    .orderBy(schema.negotiationTurns.createdAt);
}

/** Sweeps negotiations whose deterministic expiry has passed into "expired" — mirrors discount.ts's sweepExpiredOffers. */
export async function sweepExpiredNegotiations(): Promise<number> {
  const result = await db
    .update(schema.negotiations)
    .set({ status: "expired", resolvedAt: new Date() })
    .where(and(eq(schema.negotiations.status, "open"), sql`${schema.negotiations.expiresAt} < now()`))
    .returning({ id: schema.negotiations.id });
  return result.length;
}
