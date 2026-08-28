import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { recordContact, unsubscribeContact } from "@/lib/contacts";
import { enqueueNotification } from "@/lib/notifications/enqueue";

/**
 * Layer 11-4/11-2's required failure demo: an unsubscribed customer's
 * recovery link is NOT sent — suppression is a recorded outcome with
 * the rule named, read back from the database, never a silent drop.
 * This is the Track 03 "compliant escalation and stopping rules" story
 * told on the notification surface. Repeatable, self-cleaning.
 */
async function main() {
  console.log("=== Demo: an unsubscribed customer's recovery link is suppressed, not sent ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const address = `demo-unsub-${Date.now()}@example.invalid`;
  const contact = await recordContact({ merchantId: merchant.id, address, consentSource: "checkout" });
  console.log(`Contact recorded: ${contact.address} (consent: ${contact.consentSource})`);

  const unsubscribed = await unsubscribeContact(contact.id);
  if (!unsubscribed || unsubscribed.unsubscribedAt === null) {
    throw new Error("Expected the contact to be genuinely unsubscribed before continuing");
  }
  console.log(`Contact unsubscribed at ${unsubscribed.unsubscribedAt.toISOString()}.\n`);

  try {
    console.log("Enqueuing a recovery-link notification to this now-unsubscribed contact...\n");
    const outcome = await enqueueNotification({
      merchantId: merchant.id,
      recipientKind: "customer",
      contact: unsubscribed,
      notificationType: "recovery_link",
      subject: "Complete your payment",
      bodyText: "This body must never actually reach an inbox — the contact opted out.",
    });

    console.log(`Enqueue outcome: ${outcome.status.toUpperCase()}`);
    if (outcome.status === "suppressed") console.log(`Reason: ${outcome.reason}\n`);

    if (outcome.status !== "suppressed") {
      throw new Error(`Expected "suppressed", got "${outcome.status}" — an unsubscribed contact must never receive a notification`);
    }

    const [row] = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.merchantId, merchant.id));

    if (!row) throw new Error("Expected a real notification_deliveries row recording the suppression — none found");
    if (row.status !== "suppressed") throw new Error(`Expected the row's own status to be "suppressed", got "${row.status}"`);

    console.log(`Real notification_deliveries row read back: status="${row.status}", lastError="${row.lastError}"`);
    console.log("\nThe stop is recorded evidence, not a silent gap — a merchant reading their delivery log sees exactly why nothing was sent, and no email was ever attempted against a real provider.");
  } finally {
    // unsubscribeContact writes a real audit_log row. This demo runs
    // against the real seeded merchant (first by createdAt) rather than
    // a throwaway one, since a contact/unsubscribe is cheap and needs
    // no dedicated fixture merchant — so cleanup must be scoped to this
    // run's own metadata.contactId, never a blanket delete by
    // merchantId, which would wipe that merchant's genuine audit
    // history.
    await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.contactId, contact.id));
    await db.delete(schema.restockRequests).where(eq(schema.restockRequests.contactId, contact.id));
    const auditRows = await db.select({ id: schema.auditLog.id, metadata: schema.auditLog.metadata }).from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    const ownAuditIds = auditRows.filter((r) => (r.metadata as { contactId?: string })?.contactId === contact.id).map((r) => r.id);
    if (ownAuditIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.id, ownAuditIds));
    }
    await db.delete(schema.customerContacts).where(eq(schema.customerContacts.id, contact.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
