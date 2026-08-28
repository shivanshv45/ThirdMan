import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { formatPaise } from "@/lib/money";

/**
 * Writes a durable webhook_deliveries row. Never delivers synchronously
 * — see policy.ts's docstring and ARCHITECTURE.md's "The embeddable
 * widget": a merchant's own server being slow or down must never affect
 * the money-moving call site that triggered this. Called from
 * confirmCapture's two success paths (checkout/verify, the Razorpay
 * webhook route) and from issueRefund — always wrapped in try/catch at
 * the call site, since enqueueing a notification must never fail the
 * money action itself.
 */

type MoneyAction = typeof schema.moneyActions.$inferSelect;

export type OutboundWebhookEvent = "order.paid" | "order.held" | "order.refunded" | "stock.changed";

interface StockChangedData {
  variantId: string;
  sku: string;
  stock: number;
}

/**
 * Enqueues one delivery per active, subscribed merchant_webhooks row.
 * A merchant with no registered webhook, or none subscribed to this
 * event type, is a normal no-op — most merchants using only the storefront
 * or embed widget never register one.
 */
export async function enqueueWebhookEvent(
  merchantId: string,
  event: OutboundWebhookEvent,
  moneyAction: MoneyAction,
): Promise<void> {
  const webhooks = await db
    .select()
    .from(schema.merchantWebhooks)
    .where(and(eq(schema.merchantWebhooks.merchantId, merchantId), eq(schema.merchantWebhooks.status, "active")));

  const subscribed = webhooks.filter((w) => w.subscribedEvents.includes(event));
  if (subscribed.length === 0) return;

  const payload = {
    id: crypto.randomUUID(),
    event,
    createdAt: new Date().toISOString(),
    merchantId,
    data: {
      moneyActionId: moneyAction.id,
      orderId: moneyAction.razorpayEntityId,
      paymentId: moneyAction.razorpayPaymentId,
      amountPaise: moneyAction.amountPaise,
      amountDisplay: formatPaise(moneyAction.amountPaise),
      quantity: moneyAction.quantity,
      variantId: moneyAction.variantId,
    },
  };

  for (const webhook of subscribed) {
    // The dedupe unique index (webhook_deliveries_dedupe_idx) makes this
    // idempotent at the database level — confirmCapture has two
    // independent success paths (the browser's checkout signature, the
    // Razorpay webhook) that can both fire for one capture, and this
    // stops a double-fire from producing two deliveries.
    await db
      .insert(schema.webhookDeliveries)
      .values({
        merchantId,
        webhookId: webhook.id,
        eventType: event,
        payload,
        moneyActionId: moneyAction.id,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({
        // Postgres requires the arbiter's WHERE predicate to match the
        // partial index exactly (webhook_deliveries_dedupe_idx), not
        // just the column list — see FAILURES.md.
        target: [schema.webhookDeliveries.webhookId, schema.webhookDeliveries.eventType, schema.webhookDeliveries.moneyActionId],
        where: isNotNull(schema.webhookDeliveries.moneyActionId),
      });
  }
}

/** Enqueues a stock.changed notification — not tied to one money action, so it isn't deduped by the money-action unique index and can be called freely on any stock mutation worth notifying about. */
export async function enqueueStockChangedEvent(merchantId: string, data: StockChangedData): Promise<void> {
  const webhooks = await db
    .select()
    .from(schema.merchantWebhooks)
    .where(and(eq(schema.merchantWebhooks.merchantId, merchantId), eq(schema.merchantWebhooks.status, "active")));

  const subscribed = webhooks.filter((w) => w.subscribedEvents.includes("stock.changed"));
  if (subscribed.length === 0) return;

  const payload = {
    id: crypto.randomUUID(),
    event: "stock.changed" as const,
    createdAt: new Date().toISOString(),
    merchantId,
    data,
  };

  for (const webhook of subscribed) {
    await db.insert(schema.webhookDeliveries).values({
      merchantId,
      webhookId: webhook.id,
      eventType: "stock.changed",
      payload,
      nextAttemptAt: new Date(),
    });
  }
}

/** Enqueues a test delivery from the dashboard's "send a test event" button — a real row through the real queue, not a fabricated success message. */
export async function enqueueTestDelivery(merchantId: string, webhookId: string): Promise<void> {
  const [webhook] = await db
    .select()
    .from(schema.merchantWebhooks)
    .where(and(eq(schema.merchantWebhooks.id, webhookId), eq(schema.merchantWebhooks.merchantId, merchantId)));

  if (!webhook) throw new Error("Webhook not found");

  const payload = {
    id: crypto.randomUUID(),
    event: "test" as const,
    createdAt: new Date().toISOString(),
    merchantId,
    data: { message: "This is a test delivery from your ThirdMan webhook configuration." },
  };

  await db.insert(schema.webhookDeliveries).values({
    merchantId,
    webhookId: webhook.id,
    eventType: "test",
    payload,
    nextAttemptAt: new Date(),
  });

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "webhook_test_delivery_sent",
    decision: "n/a",
    reason: `Merchant sent a test webhook delivery to ${new URL(webhook.url).hostname}.`,
  });
}
