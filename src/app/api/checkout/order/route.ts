import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { decrypt } from "@/lib/crypto";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const orderRequestSchema = z.object({
  merchantId: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(999).default(1),
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

  const { merchantId, productId, quantity } = parsed.data;

  const [merchant] = await db
    .select({ keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant?.keyIdEncrypted) {
    return NextResponse.json({ error: "this merchant has not connected a Razorpay account" }, { status: 400 });
  }

  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, productId));

  if (!product || product.merchantId !== merchantId || product.status !== "active") {
    return NextResponse.json({ error: "product not found" }, { status: 404 });
  }

  const amountPaise = product.pricePaise * quantity;
  const storefrontAgent = await getOrCreateStorefrontAgent(merchantId);

  const result = await attemptMoneyAction({
    agentId: storefrontAgent.id,
    merchantId,
    type: "order_create",
    amountPaise,
    context: `Storefront checkout: ${product.name}`,
    productId: product.id,
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
