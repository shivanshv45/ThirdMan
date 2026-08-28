import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { recordContact, unsubscribeContact } from "@/lib/contacts";
import { enqueueNotification } from "@/lib/notifications/enqueue";

/**
 * enqueueNotification's real bounds: suppression (unsubscribed,
 * frequency cap) and the dedupe constraint. The dedupe test here is a
 * REGRESSION test for a real bug caught while building L11-5 — the
 * first version of onConflictDoNothing's target here didn't include
 * the partial index's WHERE predicate, so Postgres rejected it as "no
 * unique or exclusion constraint matching" the moment relatedEntityId
 * was actually set (every earlier test happened to leave it unset).
 * See restock.ts's identical fix and FAILURES.md's existing entry for
 * webhook_deliveries_dedupe_idx, which had the same shape of bug.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.merchantId, merchantId));
    await db.delete(schema.customerContacts).where(eq(schema.customerContacts.merchantId, merchantId));
    // unsubscribeContact writes a real audit_log row — must go before
    // the merchant delete, same FK-ordering lesson as everywhere else.
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("enqueueNotification", () => {
  it("a duplicate enqueue for the same (notificationType, relatedEntityId, contactId) produces exactly one row", async () => {
    const merchant = await createTestMerchant("__notif_enqueue_dedupe__");
    createdMerchantIds.push(merchant.id);
    const contact = await recordContact({ merchantId: merchant.id, address: "dedupe@example.com", consentSource: "checkout" });

    const relatedEntityId = "00000000-0000-0000-0000-0000000000aa";
    await enqueueNotification({
      merchantId: merchant.id,
      recipientKind: "customer",
      contact,
      notificationType: "recovery_link",
      subject: "Complete your payment",
      bodyText: "first enqueue",
      relatedEntityId,
    });
    await enqueueNotification({
      merchantId: merchant.id,
      recipientKind: "customer",
      contact,
      notificationType: "recovery_link",
      subject: "Complete your payment",
      bodyText: "second enqueue — should be a no-op",
      relatedEntityId,
    });

    const rows = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(inArray(schema.notificationDeliveries.relatedEntityId, [relatedEntityId]));

    expect(rows.length).toBe(1);
    expect(rows[0].bodyText).toBe("first enqueue"); // the first write stands, the second was a genuine no-op
  });

  it("suppresses (with a recorded row, never a silent drop) a send to an unsubscribed contact", async () => {
    const merchant = await createTestMerchant("__notif_enqueue_suppress__");
    createdMerchantIds.push(merchant.id);
    const contact = await recordContact({ merchantId: merchant.id, address: "unsubbed@example.com", consentSource: "checkout" });
    const unsubscribed = await unsubscribeContact(contact.id);

    const outcome = await enqueueNotification({
      merchantId: merchant.id,
      recipientKind: "customer",
      contact: unsubscribed!, // enqueueNotification trusts the caller's contact snapshot — must be freshly re-fetched after any consent change, never the pre-unsubscribe object
      notificationType: "restock_alert",
      subject: "Back in stock",
      bodyText: "should not send",
    });

    expect(outcome.status).toBe("suppressed");

    const [row] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.merchantId, merchant.id));
    expect(row.status).toBe("suppressed");
    expect(row.lastError).toMatch(/unsubscribed/i);
  });

  it("suppresses the notification once the daily frequency cap is exceeded, naming the rule", async () => {
    const merchant = await createTestMerchant("__notif_enqueue_freqcap__");
    createdMerchantIds.push(merchant.id);
    const contact = await recordContact({ merchantId: merchant.id, address: "frequent@example.com", consentSource: "checkout" });

    for (let i = 0; i < 3; i++) {
      const outcome = await enqueueNotification({
        merchantId: merchant.id,
        recipientKind: "customer",
        contact,
        notificationType: "restock_alert",
        subject: `Alert ${i}`,
        bodyText: `body ${i}`,
        relatedEntityId: `00000000-0000-0000-0000-00000000000${i}`,
      });
      expect(outcome.status).toBe("pending");
    }

    const fourth = await enqueueNotification({
      merchantId: merchant.id,
      recipientKind: "customer",
      contact,
      notificationType: "restock_alert",
      subject: "Alert 4",
      bodyText: "body 4",
      relatedEntityId: "00000000-0000-0000-0000-000000000004",
    });

    expect(fourth.status).toBe("suppressed");
    if (fourth.status === "suppressed") {
      expect(fourth.reason).toMatch(/frequency cap/i);
    }
  }, 20_000);
});
