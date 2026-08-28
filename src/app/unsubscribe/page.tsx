import { getContactByToken, unsubscribeContact, isContactable } from "@/lib/contacts";

/**
 * The public, unauthenticated one-click unsubscribe page (Layer 11-1).
 * The unsubscribe token IS the credential — requiring a login to stop
 * email would be user-hostile, and the token is unguessable (24 random
 * bytes) so this is a reasonable bar.
 *
 * Constant response for an unknown or already-used token: this page
 * never says "no such token," only ever the same confirmation, so the
 * endpoint isn't a token oracle for guessing valid ones.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const contact = token ? await getContactByToken(token) : null;

  if (contact && isContactable(contact)) {
    await unsubscribeContact(contact.id);
  }

  return (
    <main className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-lg text-center space-y-4">
        <p className="text-[var(--t-label)] uppercase tracking-[0.1em] text-on-ink-faint font-medium font-mono">Unsubscribed</p>
        <h1 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink">You&apos;re unsubscribed</h1>
        <p className="text-sm text-on-ink-dim">You won&apos;t receive any further email from this merchant. If this was a mistake, contact the merchant directly to be re-added.</p>
      </div>
    </main>
  );
}
