import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyWebhookSignature } from "@/lib/webhook-verify";
import { recordPaymentFailure } from "@/lib/recovery/intake";
import { confirmCapture } from "@/lib/gate";
import { confirmRecoveryLinkPaid } from "@/lib/recovery/sequencer";
import { logAuditEntry } from "@/lib/audit";
import { issueRewardCoinsForCapture } from "@/lib/reward-actions";
import { fundTreasuryFromCapture } from "@/lib/treasury";
import { enqueueWebhookEvent } from "@/lib/webhooks/enqueue";

/**
 * Razorpay's webhook intake. Handles payment.failed (feeds the recovery
 * pipeline's payment_failures table, source: "webhook" — see
 * recovery/intake.ts), payment.captured/order.paid (confirms a checkout
 * actually settled, the backstop for /api/checkout/verify in case the
 * browser's post-payment call never lands — tab closed, network drop
 * mid-redirect), and payment_link.paid (the only way a recovery
 * attempt's Payment Link ever resolves to "succeeded" — see
 * recovery/sequencer.ts's confirmRecoveryLinkPaid, since a link is paid
 * asynchronously, not at creation time). Every other event type is
 * acknowledged with 200 so Razorpay stops retrying delivery, without
 * doing anything.
 *
 * Idempotent by Razorpay's own event id (x-razorpay-event-id), recorded
 * in webhook_events before any side effect runs. Razorpay redelivers on
 * a missed 200 — a payment.captured delivered twice must not double-
 * capture, double-decrement stock (stock already decremented at order
 * creation, so a second capture confirming the same money_action is a
 * no-op via confirmCapture's own idempotency, but this ledger stops the
 * work from running at all on a redelivery, not just from double-writing).
 */
export async function POST(req: NextRequest) {
  // Signature verification must run over the exact raw bytes Razorpay
  // signed. req.json() re-serialises with different whitespace/key order
  // and the HMAC will never match — see FAILURES.md.
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!verifyWebhookSignature(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    // An unverifiable signature could be a forged event trying to inject
    // failures into a merchant's recovery queue or falsely confirm a
    // payment. Log it, but only scope it to a merchant if the payload
    // identifies one credibly enough to trust post-failure — otherwise
    // attributing it to a guessed merchant is worse than not logging it.
    console.warn("[webhook] signature verification failed, rejecting");
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const event = (payload as { event?: string })?.event;
  const eventId = req.headers.get("x-razorpay-event-id");

  if (!event) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  // Claim the event id before doing any work. A conflict means this
  // exact event was already processed — acknowledge and stop, don't
  // repeat the side effects. Events without an id (shouldn't happen on
  // a real Razorpay delivery, but defends against a malformed replay)
  // fall through unclaimed rather than blocking all unidentified events.
  if (eventId) {
    const [claimed] = await db
      .insert(schema.webhookEvents)
      .values({ razorpayEventId: eventId, eventType: event })
      .onConflictDoNothing({ target: schema.webhookEvents.razorpayEventId })
      .returning({ id: schema.webhookEvents.id });

    if (!claimed) {
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
    }
  }

  if (event === "payment.failed") {
    await handlePaymentFailed(payload);
  } else if (event === "payment.captured" || event === "order.paid") {
    await handlePaymentCaptured(payload);
  } else if (event === "payment_link.paid") {
    await handlePaymentLinkPaid(payload);
  }
  // Every other event type: acknowledged above by the 200 at the end,
  // deliberately doing nothing further.

  return NextResponse.json({ received: true }, { status: 200 });
}

async function handlePaymentFailed(payload: unknown): Promise<void> {
  const entity = (payload as {
    payload?: { payment?: { entity?: Record<string, unknown> } };
  })?.payload?.payment?.entity;

  if (!entity || typeof entity.order_id !== "string") {
    // A payment.failed event with no order id can't be attributed to a
    // merchant through this endpoint's only resolution path (matching
    // money_actions.razorpay_entity_id). Nothing written — see
    // recovery/intake.ts for why guessing a merchant here would be
    // worse than silence.
    return;
  }

  const orderId = entity.order_id;

  const [moneyAction] = await db
    .select({ merchantId: schema.moneyActions.merchantId })
    .from(schema.moneyActions)
    .where(eq(schema.moneyActions.razorpayEntityId, orderId));

  if (!moneyAction) {
    console.warn(`[webhook] payment.failed for unknown order ${orderId}, not attributable to a merchant`);
    return;
  }

  await recordPaymentFailure({
    merchantId: moneyAction.merchantId,
    razorpayOrderId: orderId,
    razorpayPaymentId: typeof entity.id === "string" ? entity.id : undefined,
    amountPaise: typeof entity.amount === "number" ? entity.amount : Number(entity.amount) || 0,
    declineCode: typeof entity.error_code === "string" ? entity.error_code : "UNKNOWN",
    declineDescription: typeof entity.error_description === "string" ? entity.error_description : undefined,
    source: "webhook",
    failedAt: new Date(),
  });

  await logAuditEntry({
    merchantId: moneyAction.merchantId,
    actor: "system",
    event: "payment_failure_received",
    decision: "n/a",
    reason: `Razorpay reported a failed payment for order ${orderId} (${typeof entity.error_code === "string" ? entity.error_code : "unknown code"}). Queued for recovery diagnosis.`,
    metadata: { razorpayOrderId: orderId },
  });
}

async function handlePaymentCaptured(payload: unknown): Promise<void> {
  const entity = (payload as {
    payload?: { payment?: { entity?: Record<string, unknown> } };
  })?.payload?.payment?.entity;

  if (!entity || typeof entity.order_id !== "string" || typeof entity.id !== "string") {
    console.warn("[webhook] payment.captured/order.paid with no resolvable order_id/payment id, ignoring");
    return;
  }

  const orderId = entity.order_id;
  const paymentId = entity.id;

  // Full row (not a narrow select) — Layer 10's enqueueWebhookEvent
  // below needs the complete money_actions shape to build a
  // notification payload.
  const [moneyAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.razorpayEntityId, orderId));

  if (!moneyAction) {
    // A payment this codebase never created an order for through the
    // gate — not attributable, and not possible via any code path here,
    // since every order this app creates goes through attemptMoneyAction.
    console.warn(`[webhook] payment.captured for unknown order ${orderId}, not attributable to a money action`);
    return;
  }

  // confirmCapture is itself idempotent (a second call against an
  // already-captured/held action is a no-op) — this webhook path and
  // /api/checkout/verify's browser-driven path converge on the same
  // function, whichever signal arrives first wins, the second is a no-op.
  const result = await confirmCapture(moneyAction.id, paymentId, "webhook");

  // Same reward-issuance rule as /api/checkout/verify: only on a genuine
  // capture, never a hold, and issueRewardCoinsForCapture's own
  // idempotency key (the purchase's money_action id) protects against
  // double-issuing when both this webhook and the browser's signature
  // check confirm the same payment. Same buyerSessionToken preference as
  // /api/checkout/verify — every human buyer shares one agentId (the
  // __storefront_checkout agent), so the session token is the real
  // per-buyer identity when one was recorded at order-creation time.
  const rewardIdentity = moneyAction.buyerSessionToken
    ? { sessionToken: moneyAction.buyerSessionToken }
    : moneyAction.agentId
      ? { agentId: moneyAction.agentId }
      : null;
  if (result.decision === "allow" && !moneyAction.holdOnly && moneyAction.agentId && rewardIdentity) {
    try {
      await issueRewardCoinsForCapture(moneyAction.merchantId, moneyAction.agentId, moneyAction.id, moneyAction.amountPaise, rewardIdentity, moneyAction.variantId);
    } catch (err) {
      console.warn("[webhook] reward coin issuance failed:", err);
    }
  }

  // Layer 14: fund the AI Treasury, mirroring the reward-coin issuance
  // immediately above — same capture-only rule, same dedupe guard
  // (treasury_ledger_capture_dedupe_idx) against this webhook and
  // /api/checkout/verify both confirming the same payment.
  if (result.decision === "allow" && !moneyAction.holdOnly) {
    try {
      await fundTreasuryFromCapture(moneyAction.merchantId, moneyAction.id, moneyAction.amountPaise);
    } catch (err) {
      console.warn("[webhook] treasury funding failed:", err);
    }
  }

  // Layer 10: notify the merchant's own backend, mirroring
  // /api/checkout/verify's own enqueue call. The dedupe unique index on
  // webhook_deliveries (webhookId, eventType, moneyActionId) is exactly
  // what stops this webhook path and the browser's checkout-signature
  // path from producing two deliveries when both confirm the same
  // capture — see webhooks/enqueue.ts.
  if (result.decision === "allow" && !moneyAction.holdOnly) {
    try {
      await enqueueWebhookEvent(moneyAction.merchantId, "order.paid", moneyAction);
    } catch (err) {
      console.warn("[webhook] webhook enqueue failed:", err);
    }
  }
}

async function handlePaymentLinkPaid(payload: unknown): Promise<void> {
  const paymentLinkEntity = (payload as {
    payload?: { payment_link?: { entity?: Record<string, unknown> } };
  })?.payload?.payment_link?.entity;
  const paymentEntity = (payload as {
    payload?: { payment?: { entity?: Record<string, unknown> } };
  })?.payload?.payment?.entity;

  if (!paymentLinkEntity || typeof paymentLinkEntity.id !== "string") {
    console.warn("[webhook] payment_link.paid with no resolvable payment link id, ignoring");
    return;
  }

  const amountPaid =
    typeof paymentEntity?.amount === "number"
      ? paymentEntity.amount
      : typeof paymentLinkEntity.amount_paid === "number"
        ? paymentLinkEntity.amount_paid
        : Number(paymentLinkEntity.amount_paid) || 0;

  await confirmRecoveryLinkPaid(paymentLinkEntity.id, amountPaid);
}
