import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { verifyCheckoutSignature } from "@/lib/payment-verify";
import { decrypt } from "@/lib/crypto";
import { confirmCapture } from "@/lib/gate";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { issueRewardCoinsForCapture } from "@/lib/reward-actions";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";
import { enqueueWebhookEvent } from "@/lib/webhooks/enqueue";

const verifyRequestSchema = z.object({
  moneyActionId: z.string().uuid(),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS" });
}

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

  const embedResolution = await resolveEmbedRequest(req, moneyAction.merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }
  const corsHeaders = embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined;

  const [merchant] = await db
    .select({ keySecretEncrypted: schema.merchants.razorpayKeySecretEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, moneyAction.merchantId));

  if (!merchant?.keySecretEncrypted) {
    return NextResponse.json({ error: "merchant has no connected Razorpay account" }, { status: 400, headers: corsHeaders });
  }

  const valid = verifyCheckoutSignature(
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    decrypt(merchant.keySecretEncrypted),
  );

  if (!valid) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 400, headers: corsHeaders });
  }

  const result = await confirmCapture(moneyActionId, razorpayPaymentId, "checkout_signature");

  // Reward coins are issued only on a genuine capture, never on a hold
  // (gate contract point 10 — executed is not captured, and a hold that
  // never resolves has not earned anything). Never lets a failure here
  // affect the checkout's own success response — issuing coins is
  // additive, and its own idempotency key (the purchase's money_action
  // id) protects against the webhook also triggering this.
  if (result.decision === "allow" && !moneyAction.holdOnly && moneyAction.agentId) {
    try {
      await issueRewardCoinsForCapture(moneyAction.merchantId, moneyAction.agentId, moneyAction.id, moneyAction.amountPaise, { agentId: moneyAction.agentId });
    } catch (err) {
      console.warn("[checkout/verify] reward coin issuance failed:", err);
    }
  }

  // Layer 10: notify the merchant's own backend that a real order was
  // paid, so their inventory/order system can stay in sync. Enqueue
  // only — never awaited into this response's success/failure (see
  // webhooks/enqueue.ts). A merchant's server being slow or down must
  // never affect this checkout's own confirmation. Same idempotency-key
  // protection as the reward-coin issuance above guards against the
  // payment.captured webhook (src/app/api/webhooks/razorpay) also
  // triggering this for the same capture.
  if (result.decision === "allow" && !moneyAction.holdOnly) {
    try {
      await enqueueWebhookEvent(moneyAction.merchantId, "order.paid", moneyAction);
    } catch (err) {
      console.warn("[checkout/verify] webhook enqueue failed:", err);
    }
  }

  return NextResponse.json({ decision: result.decision, reason: result.reason }, { headers: corsHeaders });
}
