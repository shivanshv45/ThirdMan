import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { recordContact, type CustomerContact } from "@/lib/contacts";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { formatPaise } from "@/lib/money";

/**
 * A buyer's "tell me when this is back" ask from the chat widget
 * (Layer 11-5). See chat.ts's out-of-stock branch for where a request
 * gets created; this module owns the request row and the restock scan.
 */

export interface RestockRequestResult {
  requestId: string;
  alreadyWaiting: boolean;
}

/**
 * Records a restock request for a variant + contact. Idempotent by the
 * (variantId, contactId) WHERE status='waiting' partial index — asking
 * twice while still waiting doesn't create a second row.
 */
export async function requestRestockAlert(merchantId: string, variantId: string, address: string): Promise<RestockRequestResult> {
  const contact = await recordContact({ merchantId, address, consentSource: "chat_restock_request" });

  const [existing] = await db
    .select()
    .from(schema.restockRequests)
    .where(and(eq(schema.restockRequests.variantId, variantId), eq(schema.restockRequests.contactId, contact.id), eq(schema.restockRequests.status, "waiting")));

  if (existing) return { requestId: existing.id, alreadyWaiting: true };

  const [inserted] = await db
    .insert(schema.restockRequests)
    .values({ merchantId, variantId, contactId: contact.id })
    .onConflictDoNothing({
      // Postgres requires the arbiter's WHERE predicate to match the
      // partial index (restock_requests_waiting_idx) exactly, not just
      // the column list — same lesson FAILURES.md already records for
      // webhook_deliveries_dedupe_idx.
      target: [schema.restockRequests.variantId, schema.restockRequests.contactId],
      where: eq(schema.restockRequests.status, "waiting"),
    })
    .returning();

  const resolved =
    inserted ??
    (await db
      .select()
      .from(schema.restockRequests)
      .where(and(eq(schema.restockRequests.variantId, variantId), eq(schema.restockRequests.contactId, contact.id), eq(schema.restockRequests.status, "waiting")))
      .then((rows) => rows[0]));

  if (!resolved) throw new Error(`requestRestockAlert: failed to resolve a restock_requests row for variant ${variantId}`);
  return { requestId: resolved.id, alreadyWaiting: false };
}

/**
 * Deliberately a periodic scan over real current stock, not a hook
 * fired on every stock write. Stock changes in several places (gate
 * reservation, release, merchant edit, catalogue import) and hooking
 * all of them is how one gets missed — a scan over real state can't
 * drift, only lag by at most one cron interval. Called by
 * POST /api/cron/run (Layer 11-3).
 *
 * status:'notified' is terminal by design: a variant oscillating in
 * and out of stock must not re-notify a customer who already heard.
 * Someone who wants another alert asks again, producing a new waiting
 * row (the old one stays 'notified', not reopened).
 */
export async function scanForRestockedVariants(limit = 200): Promise<{ notified: number }> {
  const waiting = await db
    .select({
      requestId: schema.restockRequests.id,
      merchantId: schema.restockRequests.merchantId,
      variantId: schema.restockRequests.variantId,
      contactId: schema.restockRequests.contactId,
    })
    .from(schema.restockRequests)
    .where(eq(schema.restockRequests.status, "waiting"))
    .limit(limit);

  if (waiting.length === 0) return { notified: 0 };

  let notified = 0;
  for (const request of waiting) {
    const [variant] = await db
      .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, pricePaise: schema.productVariants.pricePaise, stock: schema.productVariants.stock, productId: schema.productVariants.productId })
      .from(schema.productVariants)
      .where(and(eq(schema.productVariants.id, request.variantId), gt(schema.productVariants.stock, 0)));

    if (!variant) continue;

    const [product] = await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, variant.productId));
    const [contact] = await db.select().from(schema.customerContacts).where(eq(schema.customerContacts.id, request.contactId));
    if (!contact) continue;

    const productName = product?.name ?? "the item you asked about";
    const subject = `${productName} is back in stock`;
    const bodyText = `Good news — ${productName} (${variant.sku}) is back in stock at ${formatPaise(variant.pricePaise)}. If you'd still like it, head back to the store to check out while stock lasts.`;

    const outcome = await enqueueNotification({
      merchantId: request.merchantId,
      recipientKind: "customer",
      contact: contact as CustomerContact,
      notificationType: "restock_alert",
      subject,
      bodyText,
      relatedEntityId: request.requestId,
    });

    await db
      .update(schema.restockRequests)
      .set({ status: "notified", notifiedAt: new Date() })
      .where(eq(schema.restockRequests.id, request.requestId));

    if (outcome.status === "pending") notified += 1;
  }

  return { notified };
}
