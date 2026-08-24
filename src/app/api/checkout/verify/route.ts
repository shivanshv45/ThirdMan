import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { verifyCheckoutSignature } from "@/lib/payment-verify";
import { decrypt } from "@/lib/crypto";
import { confirmCapture } from "@/lib/gate";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const verifyRequestSchema = z.object({
  moneyActionId: z.string().uuid(),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * The browser calls this the instant Razorpay Checkout reports success.
 * A client-reported success is a hint, not proof — this is the proof
 * (see ARCHITECTURE.md's gate contract and CLAUDE.md's "explainable,
 * bounded, gated"). The signature is verified against the merchant's own
 * key secret before anything is written; the payment.captured/order.paid
 * webhook is the backstop in case this call never lands (tab closed,
 * network drop mid-redirect).
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`checkout-verify:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = verifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { moneyActionId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(eq(schema.moneyActions.id, moneyActionId));

  if (!moneyAction || moneyAction.razorpayEntityId !== razorpayOrderId) {
    return NextResponse.json({ error: "unknown order" }, { status: 404 });
  }

  const [merchant] = await db
    .select({ keySecretEncrypted: schema.merchants.razorpayKeySecretEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, moneyAction.merchantId));

  if (!merchant?.keySecretEncrypted) {
    return NextResponse.json({ error: "merchant has no connected Razorpay account" }, { status: 400 });
  }

  const valid = verifyCheckoutSignature(
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    decrypt(merchant.keySecretEncrypted),
  );

  if (!valid) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 400 });
  }

  const result = await confirmCapture(moneyActionId, razorpayPaymentId, "checkout_signature");

  return NextResponse.json({ decision: result.decision, reason: result.reason });
}
