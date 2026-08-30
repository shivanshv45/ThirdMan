import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { decrypt } from "@/lib/crypto";
import { requireSessionMerchant } from "@/lib/auth";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";

const holdOrderRequestSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(999).default(1),
  // Layer 26-5: same discipline as /api/checkout/order — optional, so a
  // caller that omits it keeps the pre-existing non-idempotent behavior.
  idempotencyKey: z.string().uuid().optional(),
});

/**
 * The escrow demo's entry point (Layer 4-5): creates a real Razorpay
 * order with payment_capture: false. Merchant-only (authenticated via
 * the session, unlike the public /api/checkout/order) since this is a
 * demo trigger for the merchant's own dashboard, not a public buy flow —
 * a real storefront's hold-and-capture would be driven by the actual
 * two-party condition (escrow between buyer and seller agents), which is
 * out of scope for a single-merchant demo to construct convincingly.
 * The payment itself is completed through the same real Razorpay
 * Checkout as a normal purchase — a genuinely authorized test-mode
 * payment, not a simulated one.
 */
export async function POST(req: NextRequest) {
  const merchant = await requireSessionMerchant();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = holdOrderRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { productId, quantity, idempotencyKey } = parsed.data;

  const [merchantRow] = await db
    .select({ keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchant.id));

  if (!merchantRow?.keyIdEncrypted) {
    return NextResponse.json({ error: "connect a Razorpay account first" }, { status: 400 });
  }

  const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
  if (!product || product.merchantId !== merchant.id || product.status !== "active") {
    return NextResponse.json({ error: "product not found" }, { status: 404 });
  }

  const [variant] = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.productId, product.id), eq(schema.productVariants.status, "active")));
  if (!variant) {
    return NextResponse.json({ error: "product not found" }, { status: 404 });
  }

  const amountPaise = variant.pricePaise * quantity;
  const storefrontAgent = await getOrCreateStorefrontAgent(merchant.id);

  const result = await attemptMoneyAction({
    agentId: storefrontAgent.id,
    merchantId: merchant.id,
    type: "order_create",
    amountPaise,
    context: `Escrow hold: ${product.name}`,
    variantId: variant.id,
    quantity,
    holdOnly: true,
    idempotencyKey,
  });

  if (result.decision !== "allow" || !result.razorpayOrderId) {
    return NextResponse.json({ error: result.reason }, { status: 200 });
  }

  return NextResponse.json({
    moneyActionId: result.moneyActionId,
    razorpayOrderId: result.razorpayOrderId,
    razorpayKeyId: decrypt(merchantRow.keyIdEncrypted),
    amountPaise,
    productName: product.name,
  });
}
