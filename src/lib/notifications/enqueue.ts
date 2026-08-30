import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { isContactable, type CustomerContact } from "@/lib/contacts";
import { MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY, frequencyCapWindowStart } from "@/lib/notifications/policy";

/**
 * Writes a notification_deliveries row. Never sends — see
 * notifications/send.ts for the actual provider call, which always
 * runs out-of-band from this. This function is fast, cheap, and
 * intended to be called from inside a try/catch at every money-action
 * call site, the same way /api/checkout/verify already wraps
 * issueRewardCoinsForCapture — a notification failure must never turn
 * a successful capture into an error.
 */

export type NotificationType = "recovery_link" | "restock_alert" | "escalation_pending" | "hold_expiring" | "notification_exhausted" | "webhook_exhausted" | "guardian_trip" | "return_request_resolved";

export interface EnqueueNotificationInput {
  merchantId: string;
  recipientKind: "customer" | "merchant";
  /** Required for recipientKind "customer" — a merchant alert has no contact row, see notificationDeliveries.contactId's schema comment. */
  contact?: CustomerContact;
  notificationType: NotificationType;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  moneyActionId?: string;
  /** The failure/hold/escalation/variant this concerns — used for the dedupe index and the frequency cap's "about the same thing" exemption is NOT applied; the cap is per-contact, not per-entity. */
  relatedEntityId?: string;
}

export type EnqueueOutcome = { status: "pending" } | { status: "suppressed"; reason: string };

async function countRecentDeliveries(contactId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.contactId, contactId),
        gte(schema.notificationDeliveries.createdAt, since),
        // Only count attempts that were genuinely sent or are still
        // trying — a row already suppressed for a different reason
        // shouldn't count twice against the same budget.
        sql`${schema.notificationDeliveries.status} != 'suppressed'`,
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Enqueues one notification. Returns "suppressed" (with the row
 * written and the reason recorded — never a silent drop) when the
 * contact is unsubscribed or has hit the daily frequency cap; returns
 * "pending" once a real, sendable row exists.
 */
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<EnqueueOutcome> {
  if (input.recipientKind === "customer") {
    if (!input.contact) {
      throw new Error(`enqueueNotification: recipientKind "customer" requires a contact (notificationType: ${input.notificationType})`);
    }

    if (!isContactable(input.contact)) {
      await writeRow(input, "suppressed", "This contact has unsubscribed. No notification was sent.");
      return { status: "suppressed", reason: "unsubscribed" };
    }

    const recentCount = await countRecentDeliveries(input.contact.id, frequencyCapWindowStart(new Date()));
    if (recentCount >= MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY) {
      const reason = `Suppressed by the per-contact daily frequency cap (${MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY}/day) — this contact already received ${recentCount} notification(s) in the last 24 hours.`;
      await writeRow(input, "suppressed", reason);
      return { status: "suppressed", reason };
    }
  }

  await writeRow(input, "pending", null);
  return { status: "pending" };
}

async function writeRow(input: EnqueueNotificationInput, status: "pending" | "suppressed", suppressedReason: string | null): Promise<void> {
  await db
    .insert(schema.notificationDeliveries)
    .values({
      merchantId: input.merchantId,
      contactId: input.contact?.id,
      recipientKind: input.recipientKind,
      notificationType: input.notificationType,
      subject: input.subject,
      bodyText: suppressedReason ? `${input.bodyText}\n\n[not sent: ${suppressedReason}]` : input.bodyText,
      bodyHtml: input.bodyHtml,
      status,
      moneyActionId: input.moneyActionId,
      relatedEntityId: input.relatedEntityId,
      lastError: suppressedReason,
    })
    // Same partial-unique-index trick as money_actions.idempotencyKey
    // and webhook_deliveries_dedupe_idx: a recovery sequencer run twice,
    // or two overlapping cron ticks both scanning for restocks, must
    // not enqueue the same notification about the same thing to the
    // same person twice. A duplicate enqueue attempt is a silent no-op,
    // not an error — the first row already stands as the real one.
    .onConflictDoNothing({
      // Postgres requires the arbiter's WHERE predicate to match the
      // partial index (notification_deliveries_dedupe_idx) exactly,
      // not just the column list — same lesson FAILURES.md already
      // records for webhook_deliveries_dedupe_idx.
      target: [schema.notificationDeliveries.notificationType, schema.notificationDeliveries.relatedEntityId, schema.notificationDeliveries.contactId],
      where: isNotNull(schema.notificationDeliveries.relatedEntityId),
    });
}
