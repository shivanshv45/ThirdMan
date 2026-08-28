import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { getContact } from "@/lib/contacts";
import { sendEmail } from "@/lib/notifications/provider";
import { hasExhaustedNotificationRetries, isRetryableSendFailure, nextNotificationAttemptTime } from "@/lib/notifications/policy";
import { getAppUrl } from "@/lib/env";

const APP_URL = getAppUrl();

export function unsubscribeUrl(token: string): string {
  return `${APP_URL}/unsubscribe?token=${token}`;
}

/**
 * Attempts one delivery for one due row. Never throws — every outcome
 * (sent, retryable failure, exhaustion) is recorded on the row and, on
 * exhaustion, in the audit log. Mirrors webhooks/deliver.ts's
 * attemptDelivery exactly, adapted for a human recipient: no HMAC
 * signature, the provider is notifications/provider.ts's sendEmail
 * instead of a raw fetch to a merchant URL.
 */
export async function attemptSend(deliveryId: string): Promise<void> {
  const [delivery] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, deliveryId));
  if (!delivery || delivery.status !== "pending") return;

  let toAddress: string;
  let token: string;

  if (delivery.recipientKind === "customer") {
    if (!delivery.contactId) {
      await finalizeTerminal(delivery.id, delivery.merchantId, delivery.notificationType, "failed", "A customer notification with no contact id — this is a programming error, not a transient failure.");
      return;
    }
    const contact = await getContact(delivery.contactId);
    if (!contact || contact.unsubscribedAt !== null) {
      await finalizeTerminal(delivery.id, delivery.merchantId, delivery.notificationType, "suppressed", "Contact unsubscribed or was removed before this delivery ran.");
      return;
    }
    toAddress = contact.address;
    token = contact.unsubscribeToken;
  } else {
    const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, delivery.merchantId));
    if (!merchant) {
      await finalizeTerminal(delivery.id, delivery.merchantId, delivery.notificationType, "failed", "Merchant no longer exists.");
      return;
    }
    toAddress = merchant.email;
    // Merchant alerts use a settings toggle, not an unsubscribe token —
    // see L11-6. The header still needs a URL; point it at the
    // dashboard's notification settings instead of a public token link.
    token = "";
  }

  const attemptNumber = delivery.attemptCount + 1;
  const now = new Date();

  const result = await sendEmail({
    to: toAddress,
    subject: delivery.subject,
    text: delivery.bodyText,
    html: delivery.bodyHtml ?? undefined,
    unsubscribeUrl: token ? unsubscribeUrl(token) : `${APP_URL}/dashboard/settings`,
  });

  if (result.ok) {
    await db
      .update(schema.notificationDeliveries)
      .set({ status: "sent", attemptCount: attemptNumber, lastAttemptAt: now, nextAttemptAt: null, providerMessageId: result.providerMessageId })
      .where(eq(schema.notificationDeliveries.id, deliveryId));
    return;
  }

  const retryable = isRetryableSendFailure(result.statusCode);
  const lastError = result.error ?? `Provider returned HTTP ${result.statusCode}`;

  if (!retryable || hasExhaustedNotificationRetries(attemptNumber)) {
    const status = retryable ? "exhausted" : "failed";
    await db
      .update(schema.notificationDeliveries)
      .set({ status, attemptCount: attemptNumber, lastAttemptAt: now, lastError, nextAttemptAt: null })
      .where(eq(schema.notificationDeliveries.id, deliveryId));

    // A stop is a recorded outcome, not a silent return — same
    // discipline as recovery/sequencer.ts and webhooks/deliver.ts.
    await logAuditEntry({
      merchantId: delivery.merchantId,
      actor: "system",
      event: retryable ? "notification_delivery_exhausted" : "notification_delivery_rejected",
      decision: "deny",
      reason: retryable
        ? `Gave up sending "${delivery.notificationType}" to this contact after ${attemptNumber} attempts (last error: ${lastError}).`
        : `"${delivery.notificationType}" was rejected by the provider and will not be retried (${lastError}).`,
      boundApplied: `notification_max_attempts:${attemptNumber}/${attemptNumber}`,
      metadata: { deliveryId, notificationType: delivery.notificationType, provider: result.provider },
    });
    return;
  }

  await db
    .update(schema.notificationDeliveries)
    .set({ attemptCount: attemptNumber, lastAttemptAt: now, lastError, nextAttemptAt: nextNotificationAttemptTime(attemptNumber, now) })
    .where(eq(schema.notificationDeliveries.id, deliveryId));
}

async function finalizeTerminal(deliveryId: string, merchantId: string, notificationType: string, status: "failed" | "suppressed", reason: string): Promise<void> {
  await db
    .update(schema.notificationDeliveries)
    .set({ status, lastError: reason, nextAttemptAt: null })
    .where(eq(schema.notificationDeliveries.id, deliveryId));

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "notification_delivery_rejected",
    decision: "deny",
    reason: `"${notificationType}" could not be sent: ${reason}`,
    metadata: { deliveryId },
  });
}

/** Drains every notification_deliveries row currently due (status pending, nextAttemptAt null or past), up to a bounded batch. Called by the cron endpoint (L11-3). */
export async function drainDueNotifications(limit = 50): Promise<{ attempted: number }> {
  const due = await db
    .select({ id: schema.notificationDeliveries.id })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.status, "pending"),
        or(isNull(schema.notificationDeliveries.nextAttemptAt), lte(schema.notificationDeliveries.nextAttemptAt, new Date())),
      ),
    )
    .limit(limit);

  for (const row of due) {
    await attemptSend(row.id);
  }

  return { attempted: due.length };
}
