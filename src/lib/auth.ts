import { eq, and, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";

export { hashPassword, verifyPassword } from "@/lib/password";

/**
 * Session creation/lookup and the session cookie. DB-backed sessions
 * (not JWTs) so a session can be revoked by deleting its row. Depends
 * on next/headers, so only usable inside a Next.js request scope —
 * password hashing lives in src/lib/password.ts for code (like
 * scripts/seed.ts) that needs it outside one.
 */

const SESSION_COOKIE = "session_id";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(merchantId: string): Promise<string> {
  const [session] = await db
    .insert(schema.sessions)
    .values({
      merchantId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning();

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });

  return session.id;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
  }
  cookieStore.delete(SESSION_COOKIE);
}

/** Resolves the logged-in merchant from the session cookie, or null. Never throws on a missing/expired session — that's just "not logged in." */
export async function getSessionMerchant() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const [row] = await db
    .select({ merchant: schema.merchants })
    .from(schema.sessions)
    .innerJoin(schema.merchants, eq(schema.sessions.merchantId, schema.merchants.id))
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, new Date())));

  return row?.merchant ?? null;
}

/** Same as getSessionMerchant but throws, for pages/actions that require a logged-in merchant rather than treating it as optional. */
export async function requireSessionMerchant() {
  const merchant = await getSessionMerchant();
  if (!merchant) {
    throw new Error("Not authenticated");
  }
  return merchant;
}
