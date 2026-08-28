import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptDelivery } from "./deliver";

const DRAIN_BATCH_LIMIT = 50;

/**
 * Drains every pending delivery whose nextAttemptAt is due. This is the
 * one place that needs a real scheduler in production (Vercel Cron or
 * equivalent) — there is no background worker process in this stack.
 * See ARCHITECTURE.md's "The embeddable widget" and DECISIONS.md for
 * why this is a pull-based drain rather than a push queue.
 */
export async function drainDueDeliveries(): Promise<{ attempted: number }> {
  const due = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.status, "pending"),
        or(isNull(schema.webhookDeliveries.nextAttemptAt), lte(schema.webhookDeliveries.nextAttemptAt, new Date())),
      ),
    )
    .limit(DRAIN_BATCH_LIMIT);

  for (const row of due) {
    await attemptDelivery(row.id);
  }

  return { attempted: due.length };
}

/** Re-enqueues a failed or exhausted delivery for another attempt — the dashboard's Retry action on a delivery-log row. Resets the attempt count so the full backoff schedule runs again. */
export async function retryDelivery(merchantId: string, deliveryId: string): Promise<void> {
  const [delivery] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(and(eq(schema.webhookDeliveries.id, deliveryId), eq(schema.webhookDeliveries.merchantId, merchantId)));

  if (!delivery) throw new Error("Delivery not found");
  if (delivery.status !== "failed" && delivery.status !== "exhausted") {
    throw new Error(`Cannot retry a delivery with status "${delivery.status}"`);
  }

  await db
    .update(schema.webhookDeliveries)
    .set({ status: "pending", attemptCount: 0, nextAttemptAt: new Date(), lastError: null, lastStatusCode: null })
    .where(eq(schema.webhookDeliveries.id, deliveryId));
}
