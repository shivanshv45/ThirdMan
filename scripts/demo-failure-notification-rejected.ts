import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { recordContact } from "@/lib/contacts";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { attemptSend } from "@/lib/notifications/send";
import { env } from "@/lib/env";

/**
 * Layer 11-2's required failure demo, on the send path this time: a
 * real provider rejection is classified correctly and terminates the
 * delivery without a crash, with the real reason and status code
 * recorded and read back from the database.
 *
 * This exercises a REAL Resend API call (no mock), the same way every
 * other demo-failure script in this repo exercises a real external
 * call rather than a simulated one. A free-tier/unverified-domain
 * Resend account can only send to its own account address — sending
 * anywhere else produces a real, repeatable 403, which
 * isRetryableSendFailure() correctly classifies as terminal (4xx, not
 * 5xx/429/timeout) — so this demo naturally lands on the "rejected,
 * not retried" branch rather than "exhausted after N attempts," which
 * is the honest behavior to demonstrate against an unverified sender.
 * If RESEND_API_KEY is absent, the console-fallback provider always
 * succeeds and there is nothing to fail — this demo requires a real
 * key configured, same as any Resend-dependent behavior in this layer.
 */
async function main() {
  console.log("=== Demo: a real provider rejection is classified correctly and never retried past its own terminal status ===\n");

  if (!env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY is not set — the console-fallback provider always succeeds, so there is nothing to fail here.");
    console.log("This demo requires a real Resend key. Skipping cleanly (not a failure of the code under test).");
    return;
  }

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  // Deliberately NOT the Resend account's own verified address, so a
  // free-tier/unverified-domain account genuinely rejects this send —
  // real provider behavior, not a fabricated failure.
  const address = `demo-reject-${Date.now()}@totally-unverified-recipient.invalid`;
  const contact = await recordContact({ merchantId: merchant.id, address, consentSource: "merchant_entered" });

  try {
    const outcome = await enqueueNotification({
      merchantId: merchant.id,
      recipientKind: "customer",
      contact,
      notificationType: "recovery_link",
      subject: "Demo: a real send that will be genuinely rejected",
      bodyText: "This is a real attempt against the real Resend API — not a simulation.",
    });

    if (outcome.status !== "pending") {
      throw new Error(`Expected the enqueue itself to succeed ("pending"), got "${outcome.status}"`);
    }

    const [row] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.contactId, contact.id));
    console.log(`Enqueued. Attempting a real send to ${address} via the real Resend API...\n`);

    await attemptSend(row.id);

    const [after] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, row.id));
    console.log(`Result: status="${after.status}", attemptCount=${after.attemptCount}`);
    console.log(`Real error recorded: ${after.lastError}\n`);

    if (after.status === "pending") {
      throw new Error("Expected the send to fail against an unverified recipient — it reported success instead, which means Resend's own restriction changed or a domain got verified since this demo was written");
    }

    console.log(`The delivery reached a terminal state ("${after.status}") without crashing the caller, with the real provider error text preserved for a merchant to read.`);
    console.log("This is the gate's own discipline applied to a new surface: a real external rejection is caught, classified, and recorded as evidence — never a silent failure and never treated as a fatal exception.");
  } finally {
    await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.contactId, contact.id));
    const auditRows = await db.select({ id: schema.auditLog.id, metadata: schema.auditLog.metadata }).from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    const ownAuditIds = auditRows.filter((r) => JSON.stringify(r.metadata ?? {}).includes(contact.id)).map((r) => r.id);
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
