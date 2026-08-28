import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getPendingEscalations } from "@/lib/dashboard";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { getAppUrl } from "@/lib/env";

/**
 * Merchant-facing digest alerts (Layer 11-6). Same queue and same
 * bounds as customer notifications (notifications/enqueue.ts), just a
 * different recipientKind — the merchant's own verified `merchants.email`,
 * no contact row needed, no unsubscribe token (a merchant has an
 * account; they get a settings toggle instead — see
 * dashboard/settings/actions.ts's updateAlertSettings).
 *
 * Deliberately a DIGEST, not one email per event: a busy merchant on a
 * bad day would otherwise get a dozen emails and set up a filter rule
 * that silences all of them, including the ones that matter. At most
 * one digest per merchant per day (lastDigestSentAt), listing counts
 * and links back into the dashboard — never a customer's email address
 * or any other PII, since a merchant alert body is a smaller trust
 * boundary than the dashboard itself.
 */

const APP_URL = getAppUrl();
const DIGEST_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function getAlertSettings(merchantId: string) {
  const [row] = await db.select().from(schema.merchantAlertSettings).where(eq(schema.merchantAlertSettings.merchantId, merchantId));
  return (
    row ?? {
      merchantId,
      escalationPendingEnabled: true,
      holdExpiringEnabled: true,
      notificationExhaustedEnabled: true,
      webhookExhaustedEnabled: true,
      lastDigestSentAt: null as Date | null,
      updatedAt: new Date(),
    }
  );
}

interface DigestCounts {
  pendingEscalations: number;
  holdsExpiringSoon: number;
  exhaustedNotifications: number;
  exhaustedWebhooks: number;
}

async function countExhaustedNotifications(merchantId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.notificationDeliveries)
    .where(and(eq(schema.notificationDeliveries.merchantId, merchantId), eq(schema.notificationDeliveries.status, "exhausted"), gte(schema.notificationDeliveries.lastAttemptAt, since)));
  return Number(row?.count ?? 0);
}

async function countHoldsExpiringSoon(merchantId: string, withinMs: number): Promise<number> {
  const cutoff = new Date(Date.now() + withinMs);
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.escrowHolds)
    .where(and(eq(schema.escrowHolds.merchantId, merchantId), eq(schema.escrowHolds.outcome, "held"), lte(schema.escrowHolds.expiresAt, cutoff)));
  return Number(row?.count ?? 0);
}

/** L10's outbound webhook queue — counted here the same way the cron route registers its drain job: directly, since it's already part of this schema. */
async function countExhaustedWebhooks(merchantId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.webhookDeliveries)
    .where(and(eq(schema.webhookDeliveries.merchantId, merchantId), eq(schema.webhookDeliveries.status, "exhausted"), gte(schema.webhookDeliveries.lastAttemptAt, since)));
  return Number(row?.count ?? 0);
}

function composeDigestBody(counts: DigestCounts, merchantName: string): { subject: string; text: string } {
  const lines: string[] = [];
  if (counts.pendingEscalations > 0) lines.push(`- ${counts.pendingEscalations} purchase(s) waiting on your approval — ${APP_URL}/dashboard`);
  if (counts.holdsExpiringSoon > 0) lines.push(`- ${counts.holdsExpiringSoon} escrow hold(s) expiring within 24h — ${APP_URL}/dashboard/escrow`);
  if (counts.exhaustedNotifications > 0) lines.push(`- ${counts.exhaustedNotifications} customer notification(s) failed to deliver — ${APP_URL}/dashboard/recovery`);
  if (counts.exhaustedWebhooks > 0) lines.push(`- ${counts.exhaustedWebhooks} webhook delivery(ies) to your server failed — ${APP_URL}/dashboard/embed`);

  return {
    subject: `${merchantName}: ${lines.length} thing${lines.length === 1 ? "" : "s"} need your attention`,
    text: `Here's what's waiting on you:\n\n${lines.join("\n")}\n\nThis is a daily summary — you won't get another until tomorrow, even if more comes in.`,
  };
}

/**
 * Composes and enqueues at most one digest per merchant per day, only
 * for alert types the merchant hasn't turned off, and only when there
 * is genuinely something to report — an empty digest is worse than no
 * digest, it trains a merchant to stop reading them.
 */
export async function sendMerchantDigestIfDue(merchantId: string): Promise<{ sent: boolean; reason: string }> {
  const settings = await getAlertSettings(merchantId);

  if (settings.lastDigestSentAt && Date.now() - settings.lastDigestSentAt.getTime() < DIGEST_MIN_INTERVAL_MS) {
    return { sent: false, reason: "A digest was already sent within the last 24 hours." };
  }

  const [merchant] = await db.select({ name: schema.merchants.name, email: schema.merchants.email }).from(schema.merchants).where(eq(schema.merchants.id, merchantId));
  if (!merchant) return { sent: false, reason: "Merchant not found." };

  const since = new Date(Date.now() - DIGEST_MIN_INTERVAL_MS);
  const counts: DigestCounts = {
    pendingEscalations: settings.escalationPendingEnabled ? (await getPendingEscalations(merchantId)).length : 0,
    holdsExpiringSoon: settings.holdExpiringEnabled ? await countHoldsExpiringSoon(merchantId, DIGEST_MIN_INTERVAL_MS) : 0,
    exhaustedNotifications: settings.notificationExhaustedEnabled ? await countExhaustedNotifications(merchantId, since) : 0,
    exhaustedWebhooks: settings.webhookExhaustedEnabled ? await countExhaustedWebhooks(merchantId, since) : 0,
  };

  const total = counts.pendingEscalations + counts.holdsExpiringSoon + counts.exhaustedNotifications + counts.exhaustedWebhooks;
  if (total === 0) return { sent: false, reason: "Nothing to report." };

  const { subject, text } = composeDigestBody(counts, merchant.name);

  await enqueueNotification({
    merchantId,
    recipientKind: "merchant",
    notificationType: "escalation_pending", // the digest's dominant/representative type; body carries the real breakdown
    subject,
    bodyText: text,
  });

  await db
    .insert(schema.merchantAlertSettings)
    .values({ merchantId, lastDigestSentAt: new Date() })
    .onConflictDoUpdate({ target: schema.merchantAlertSettings.merchantId, set: { lastDigestSentAt: new Date(), updatedAt: new Date() } });

  return { sent: true, reason: `Digest sent — ${total} item(s).` };
}

/** Runs the digest across every merchant — called by the cron endpoint (L11-3). */
export async function sendDueMerchantDigests(): Promise<{ sent: number; checked: number }> {
  const merchants = await db.select({ id: schema.merchants.id }).from(schema.merchants);
  let sent = 0;
  for (const merchant of merchants) {
    try {
      const result = await sendMerchantDigestIfDue(merchant.id);
      if (result.sent) sent += 1;
    } catch (err) {
      console.error(`[merchant-alerts] digest failed for merchant ${merchant.id}:`, err);
    }
  }
  return { sent, checked: merchants.length };
}
