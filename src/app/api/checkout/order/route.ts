import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { acceptOffer } from "@/lib/discount";
import { decrypt } from "@/lib/crypto";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

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
    sessionToken: z.string().uuid().optional(),
  })
  .refine((v) => v.productId !== undefined || v.offerId !== undefined, {
    message: "either productId or offerId is required",
  });

// Public and unauthenticated — every allowed request creates a real
// Razorpay order. 10/minute per IP is well above a real shopper's pace.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Creates a real Razorpay order for a human buyer on the public
 * storefront (Layer 4-2). Routes through the same gate every other money
 * action does — the storefront has no special path around it. The
 * buyer isn't an AI agent, so this uses a hidden, bounded per-merchant
 * "storefront" agent (same pattern as the recovery pipeline's own
 * hidden agent — see sequencer.ts), keeping every purchase bounded by a
 * real spend cap rather than exempted from one.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`checkout-order:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
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

  const { merchantId, productId, variantId, quantity, offerId, sessionToken } = parsed.data;

  const [merchant] = await db
    .select({ keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant?.keyIdEncrypted) {
    return NextResponse.json({ error: "this merchant has not connected a Razorpay account" }, { status: 400 });
  }

  const storefrontAgent = await getOrCreateStorefrontAgent(merchantId);

  // Layer 6-3: buy an accepted upsell's bundle instead of a single
  // product. The gate (via discount.ts's resolveOffer) re-derives the
  // amount from the bundle's own merchant-set price — the accept step
  // below only claims the offer, it never determines what gets charged.
  if (offerId) {
    if (!sessionToken) {
      return NextResponse.json({ error: "sessionToken is required to redeem an offer" }, { status: 400 });
    }

    const [offer] = await db.select().from(schema.offers).where(eq(schema.offers.id, offerId));
    if (!offer || offer.merchantId !== merchantId) {
      return NextResponse.json({ error: "offer not found" }, { status: 404 });
    }

    const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, offer.bundleId));
    if (!bundle) {
      return NextResponse.json({ error: "offer not found" }, { status: 404 });
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
      context: `Storefront checkout: bundle "${bundle.name}"`,
      offerId,
      sessionToken,
    });

    if (result.decision !== "allow" || !result.razorpayOrderId) {
      return NextResponse.json({ error: result.reason }, { status: 200 });
    }

    return NextResponse.json({
      moneyActionId: result.moneyActionId,
      razorpayOrderId: result.razorpayOrderId,
      razorpayKeyId: decrypt(merchant.keyIdEncrypted),
      amountPaise: bundle.bundlePricePaise,
      productName: bundle.name,
    });
  }

  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId!));

  if (!product || product.merchantId !== merchantId || product.status !== "active") {
    return NextResponse.json({ error: "product not found" }, { status: 404 });
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
    return NextResponse.json({ error: "product not found" }, { status: 404 });
  }

  const amountPaise = variant.pricePaise * quantity;

  const result = await attemptMoneyAction({
    agentId: storefrontAgent.id,
    merchantId,
    type: "order_create",
    amountPaise,
    context: `Storefront checkout: ${product.name}`,
    variantId: variant.id,
    quantity,
  });

  if (result.decision !== "allow" || !result.razorpayOrderId) {
    return NextResponse.json({ error: result.reason }, { status: 200 });
  }

  return NextResponse.json({
    moneyActionId: result.moneyActionId,
    razorpayOrderId: result.razorpayOrderId,
    razorpayKeyId: decrypt(merchant.keyIdEncrypted),
    amountPaise,
    productName: product.name,
  });
}
