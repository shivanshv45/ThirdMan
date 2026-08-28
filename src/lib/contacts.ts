import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * A customer's contact address, with consent provenance and an
 * unsubscribe token from birth. This is the module everything in Layer
 * 11's notification spine hangs off — see
 * plans/layer-11-notifications-and-token-rewards.md's L11-1.
 *
 * Every contact row carries how it was obtained and an unsubscribe
 * token, no exceptions, even for a use (a recovery-link email about the
 * customer's own failed payment) that arguably wouldn't strictly need
 * one under legitimate-interest reasoning. This module is the sole
 * writer of customer_contacts and the sole place isContactable is
 * decided — notifications/enqueue.ts calls it and nothing else does,
 * so there is never a second opinion about whether someone may be
 * emailed.
 */

export type CustomerContact = typeof schema.customerContacts.$inferSelect;
export type ConsentSource = (typeof schema.contactConsentSourceEnum.enumValues)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trims, lowercases, and validates shape. Does not attempt to validate
 * deliverability — that is the provider's job, and guessing here just
 * produces false rejections of real addresses.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function generateUnsubscribeToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Upserts a contact on (merchantId, channel, address). A customer who
 * both fails a payment and later asks for a restock alert is ONE row
 * with one unsubscribe token, not two — unsubscribing from one context
 * must not leave the other still sending.
 *
 * The unsubscribe token is generated once, at insert, and NEVER
 * rotated on a later upsert — an unsubscribe link already sent in an
 * email must keep working for the life of the contact.
 *
 * Never resurrects an unsubscribed contact: if unsubscribedAt is
 * already set, this returns the row as-is. Re-consent is a deliberate
 * act (a merchant or customer explicitly re-opting-in), never a side
 * effect of a later purchase or chat message.
 */
export async function recordContact(input: {
  merchantId: string;
  channel?: "email";
  address: string;
  consentSource: ConsentSource;
}): Promise<CustomerContact> {
  const channel = input.channel ?? "email";
  const normalized = normalizeEmail(input.address);
  if (!normalized) {
    throw new Error(`recordContact: "${input.address}" is not a valid email address.`);
  }

  const [existing] = await db
    .select()
    .from(schema.customerContacts)
    .where(
      and(
        eq(schema.customerContacts.merchantId, input.merchantId),
        eq(schema.customerContacts.channel, channel),
        eq(schema.customerContacts.address, normalized),
      ),
    );

  if (existing) return existing;

  const [inserted] = await db
    .insert(schema.customerContacts)
    .values({
      merchantId: input.merchantId,
      channel,
      address: normalized,
      consentSource: input.consentSource,
      unsubscribeToken: generateUnsubscribeToken(),
    })
    .onConflictDoNothing({
      target: [schema.customerContacts.merchantId, schema.customerContacts.channel, schema.customerContacts.address],
    })
    .returning();

  // A concurrent request may have won the insert race — re-read rather
  // than assume `inserted` exists, same pattern as embed.ts's
  // getOrCreateEmbedConfig.
  const resolved =
    inserted ??
    (await db
      .select()
      .from(schema.customerContacts)
      .where(
        and(
          eq(schema.customerContacts.merchantId, input.merchantId),
          eq(schema.customerContacts.channel, channel),
          eq(schema.customerContacts.address, normalized),
        ),
      )
      .then((rows) => rows[0]));

  if (!resolved) throw new Error(`recordContact: failed to resolve a contact row for ${input.merchantId}/${channel}/${normalized}`);
  return resolved;
}

export async function getContact(contactId: string): Promise<CustomerContact | null> {
  const [contact] = await db.select().from(schema.customerContacts).where(eq(schema.customerContacts.id, contactId));
  return contact ?? null;
}

export async function getContactByToken(token: string): Promise<CustomerContact | null> {
  if (!token) return null;
  const [contact] = await db.select().from(schema.customerContacts).where(eq(schema.customerContacts.unsubscribeToken, token));
  return contact ?? null;
}

/**
 * The bound: may this contact be sent anything, ever, right now?
 * unsubscribedAt is a one-way door — once set, this stays false
 * regardless of what triggers a later enqueue attempt.
 */
export function isContactable(contact: Pick<CustomerContact, "unsubscribedAt">): boolean {
  return contact.unsubscribedAt === null;
}

/**
 * Marks a contact unsubscribed. Idempotent — calling this twice is not
 * an error, it just leaves unsubscribedAt as the first call set it.
 * Writes an audit entry: unsubscribing is a real, permanent decision
 * about a contactable customer and belongs in the trail like any other
 * consent-affecting event.
 */
export async function unsubscribeContact(contactId: string): Promise<CustomerContact | null> {
  const contact = await getContact(contactId);
  if (!contact) return null;
  if (contact.unsubscribedAt !== null) return contact;

  // Conditional on unsubscribedAt still being null in the same
  // statement, so two concurrent unsubscribe clicks can't both "win" —
  // whichever loses affects zero rows and just re-reads the result.
  const [updated] = await db
    .update(schema.customerContacts)
    .set({ unsubscribedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.customerContacts.id, contactId), isNull(schema.customerContacts.unsubscribedAt)))
    .returning();

  const result = updated ?? contact;

  await logAuditEntry({
    merchantId: result.merchantId,
    actor: "customer",
    event: "customer_unsubscribed",
    decision: "n/a",
    reason: `Customer contact ${result.id.slice(0, 8)} unsubscribed via the one-click unsubscribe link. No further notifications will be sent to this address for this merchant.`,
    metadata: { contactId: result.id, channel: result.channel },
  });

  return result;
}
