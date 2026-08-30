import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { acceptOffer } from "@/lib/discount";
import { decrypt } from "@/lib/crypto";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { resolveCartForCheckout, getConversationBySession, clearCart } from "@/lib/cart";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";

const orderRequestSchema = z
  .object({
    merchantId: z.string().uuid(),
    productId: z.string().uuid().optional(),
    // Optional (Layer 5-7): when the buyer chat resolved a specific
    // variant (not just the product's default), it passes that variant's
    // own id so checkout buys exactly what was in the cart, not whichever
    // variant happens to be first. Falls back to the product's first
    // active variant when omitted, matching the storefront card's own
    // single-variant assumption.
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().positive().max(999).default(1),
    // Layer 6-3: buy the accepted upsell's bundle instead of a single
    // product/variant. Mutually exclusive with productId — the offer
    // already names what's being bought and at what price.
    offerId: z.string().uuid().optional(),
    // Layer 8: buy at an agreed negotiated price instead. Mutually
    // exclusive with productId/offerId — the negotiation already names
    // the variant, quantity, and agreed price.
    negotiationId: z.string().uuid().optional(),
    // Layer 9-close-out: check out the buyer chat's real multi-item
    // cart. Mutually exclusive with productId/offerId/negotiationId —
    // the cart's own lines (cart_items) already name every variant and
    // quantity being bought. Resolved from sessionToken (below), the
    // same identity every other buyer-chat surface already uses, rather
    // than exposing a separate conversationId to the client.
    cart: z.literal(true).optional(),
    sessionToken: z.string().uuid().optional(),
    // Layer 26-5: one per checkout attempt, generated client-side by
    // BuyButton — threaded into attemptMoneyAction so a retried request
    // (a flaky connection's own retry, a double-submit) replays the
    // first attempt's outcome through the gate's existing idempotency
    // mechanism instead of creating a second order. Optional so a
    // direct API caller that doesn't send one is unaffected — it simply
    // gets the pre-existing, non-idempotent behavior it always had.
    idempotencyKey: z.string().uuid().optional(),
  })
  .refine((v) => v.productId !== undefined || v.offerId !== undefined || v.negotiationId !== undefined || v.cart !== undefined, {
    message: "one of productId, offerId, negotiationId, or cart is required",
  });

// Public and unauthenticated — every allowed request creates a real
// Razorpay order. 10/minute per IP is well above a real shopper's pace.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS" });
}

/**
 * Creates a real Razorpay order for a human buyer on the public
 * storefront (Layer 4-2). Routes through the same gate every other money
 * action does — the storefront has no special path around it. The
 * buyer isn't an AI agent, so this uses a hidden, bounded per-merchant
 * "storefront" agent (same pattern as the recovery pipeline's own
 * hidden agent — see sequencer.ts), keeping every purchase bounded by a
 * real spend cap rather than exempted from one.
 *
 * Layer 10: a request carrying the X-Embed-Key header is the embeddable
 * widget on the merchant's own site, subject to the origin allowlist
 * below. It still
 * shares the same storefront agent and spend cap as /store/[merchantId]
 * — see ARCHITECTURE.md's "The embeddable widget" for why that's the
 * deliberate default. Attribution (which origin this came from) is
 * folded into the money action's context string only, never a new cap.
 */
export async function POST(req: NextRequest) {
  const rateLimit = await checkRateLimit(`checkout-order:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many checkout attempts. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = orderRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { merchantId, productId, variantId, quantity, offerId, negotiationId, cart: wantsCart, sessionToken, idempotencyKey } = parsed.data;

  const embedResolution = await resolveEmbedRequest(req, merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }
  const corsHeaders = embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined;
  const contextSuffix = embedResolution.ok === true ? ` (embed: ${new URL(embedResolution.origin).hostname})` : "";

  const [merchant] = await db
    .select({ keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant?.keyIdEncrypted) {
    return NextResponse.json({ error: "this merchant has not connected a Razorpay account" }, { status: 400, headers: corsHeaders });
  }

  const storefrontAgent = await getOrCreateStorefrontAgent(merchantId);

  // Layer 6-3: buy an accepted upsell's bundle instead of a single
  // product. The gate (via discount.ts's resolveOffer) re-derives the
  // amount from the bundle's own merchant-set price — the accept step
  // below only claims the offer, it never determines what gets charged.
  if (offerId) {
    if (!sessionToken) {
      return NextResponse.json({ error: "sessionToken is required to redeem an offer" }, { status: 400, headers: corsHeaders });
    }

    const [offer] = await db.select().from(schema.offers).where(eq(schema.offers.id, offerId));
    if (!offer || offer.merchantId !== merchantId) {
      return NextResponse.json({ error: "offer not found" }, { status: 404, headers: corsHeaders });
    }

    const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, offer.bundleId));
    if (!bundle) {
      return NextResponse.json({ error: "offer not found" }, { status: 404, headers: corsHeaders });
    }

    // acceptOffer is a no-op (returns false) if the offer was already
    // accepted by this same session — attemptMoneyAction's own
    // offer_status check below still re-verifies "accepted", so a
    // repeat call here is safe either way.
    if (offer.status === "offered") {
      await acceptOffer(merchantId, offerId, { sessionToken });
    }

    const result = await attemptMoneyAction({
      agentId: storefrontAgent.id,
      merchantId,
      type: "order_create",
      amountPaise: bundle.bundlePricePaise,
      context: `Storefront checkout: bundle "${bundle.name}"${contextSuffix}`,
      offerId,
      sessionToken,
      idempotencyKey,
    });

    if (result.decision !== "allow" || !result.razorpayOrderId) {
      return NextResponse.json({ error: result.reason }, { status: 200, headers: corsHeaders });
    }

    return NextResponse.json(
      {
        moneyActionId: result.moneyActionId,
        razorpayOrderId: result.razorpayOrderId,
        razorpayKeyId: decrypt(merchant.keyIdEncrypted),
        amountPaise: bundle.bundlePricePaise,
        productName: bundle.name,
      },
      { headers: corsHeaders },
    );
  }

  // Layer 8: buy at an agreed negotiated price. The gate (via
  // negotiation.ts's resolveNegotiation) re-derives the amount from the
  // negotiation's own agreed price — this route never computes or trusts
  // a price itself, same discipline as the offerId branch above.
  if (negotiationId) {
    if (!sessionToken) {
      return NextResponse.json({ error: "sessionToken is required to redeem a negotiated price" }, { status: 400, headers: corsHeaders });
    }

    const [negotiation] = await db.select().from(schema.negotiations).where(eq(schema.negotiations.id, negotiationId));
    if (!negotiation || negotiation.merchantId !== merchantId) {
      return NextResponse.json({ error: "negotiation not found" }, { status: 404, headers: corsHeaders });
    }
    if (negotiation.status !== "agreed" || negotiation.agreedUnitPricePaise === null) {
      return NextResponse.json({ error: `Negotiation is "${negotiation.status}", not agreed.` }, { status: 200, headers: corsHeaders });
    }

    const amountPaise = negotiation.agreedUnitPricePaise * negotiation.quantity;

    const result = await attemptMoneyAction({
      agentId: storefrontAgent.id,
      merchantId,
      type: "order_create",
      amountPaise,
      context: `Storefront checkout: negotiated price for variant ${negotiation.variantId}${contextSuffix}`,
      negotiationId,
      sessionToken,
      idempotencyKey,
    });

    if (result.decision !== "allow" || !result.razorpayOrderId) {
      return NextResponse.json({ error: result.reason }, { status: 200, headers: corsHeaders });
    }

    return NextResponse.json(
      {
        moneyActionId: result.moneyActionId,
        razorpayOrderId: result.razorpayOrderId,
        razorpayKeyId: decrypt(merchant.keyIdEncrypted),
        amountPaise,
        productName: "Negotiated price",
      },
      { headers: corsHeaders },
    );
  }

  // Layer 9-close-out: buy the buyer chat's real multi-item cart. The
  // gate (via cart.ts's resolveCartForCheckout) re-derives the total and
  // every line's price/stock fresh from the live catalogue — this route
  // never computes or trusts a cart total itself, same discipline as the
  // offerId/negotiationId branches above.
  if (wantsCart) {
    if (!sessionToken) {
      return NextResponse.json({ error: "sessionToken is required to check out a cart" }, { status: 400, headers: corsHeaders });
    }

    const conversation = await getConversationBySession(merchantId, sessionToken);
    if (!conversation) {
      return NextResponse.json({ error: "cart not found" }, { status: 404, headers: corsHeaders });
    }

    const { cart, failure } = await resolveCartForCheckout(merchantId, conversation.id);
    if (failure) {
      return NextResponse.json({ error: failure.reason }, { status: 200, headers: corsHeaders });
    }

    const result = await attemptMoneyAction({
      agentId: storefrontAgent.id,
      merchantId,
      type: "order_create",
      amountPaise: cart!.amountPaise,
      context: `Storefront checkout: cart (${cart!.lines.length} item${cart!.lines.length === 1 ? "" : "s"})${contextSuffix}`,
      cartConversationId: conversation.id,
      idempotencyKey,
    });

    if (result.decision !== "allow" || !result.razorpayOrderId) {
      return NextResponse.json({ error: result.reason }, { status: 200, headers: corsHeaders });
    }

    // The cart is cleared only once the order is genuinely allowed — a
    // denied attempt leaves the cart intact so the buyer can retry or
    // adjust it, same as every other path here never mutating state on
    // a denial. clearCart is a plain DELETE on the conversation's own
    // cart_items — safe to call again on a replayed allow (an idempotency
    // hit against a cart already cleared by the first attempt), since
    // deleting an already-empty set of rows is a no-op, not an error.
    await clearCart(conversation.id);

    return NextResponse.json(
      {
        moneyActionId: result.moneyActionId,
        razorpayOrderId: result.razorpayOrderId,
        razorpayKeyId: decrypt(merchant.keyIdEncrypted),
        amountPaise: cart!.amountPaise,
        productName: `Cart (${cart!.lines.length} item${cart!.lines.length === 1 ? "" : "s"})`,
      },
      { headers: corsHeaders },
    );
  }

  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId!));

  if (!product || product.merchantId !== merchantId || product.status !== "active") {
    return NextResponse.json({ error: "product not found" }, { status: 404, headers: corsHeaders });
  }

  // If the caller (e.g. the buyer chat, Layer 5-7) already resolved a
  // specific variant, buy exactly that one — it must still belong to
  // this product. Otherwise fall back to the product's first active
  // variant, matching the storefront card's single-variant assumption
  // (multi-variant selection on the storefront grid itself isn't built).
  const [variant] = variantId
    ? await db
        .select()
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.id, variantId), eq(schema.productVariants.productId, product.id), eq(schema.productVariants.status, "active")))
    : await db
        .select()
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.productId, product.id), eq(schema.productVariants.status, "active")));

  if (!variant) {
    return NextResponse.json({ error: "product not found" }, { status: 404, headers: corsHeaders });
  }

  const amountPaise = variant.pricePaise * quantity;

  const result = await attemptMoneyAction({
    agentId: storefrontAgent.id,
    merchantId,
    type: "order_create",
    amountPaise,
    context: `Storefront checkout: ${product.name}${contextSuffix}`,
    variantId: variant.id,
    quantity,
    idempotencyKey,
  });

  if (result.decision !== "allow" || !result.razorpayOrderId) {
    return NextResponse.json({ error: result.reason }, { status: 200, headers: corsHeaders });
  }

  return NextResponse.json(
    {
      moneyActionId: result.moneyActionId,
      razorpayOrderId: result.razorpayOrderId,
      razorpayKeyId: decrypt(merchant.keyIdEncrypted),
      amountPaise,
      productName: product.name,
    },
    { headers: corsHeaders },
  );
}
