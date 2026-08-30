import { eq, and, gt, lt, ne } from "drizzle-orm";
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

/**
 * Session rotation on login (Layer 26-2): if a session cookie is already
 * present when this is called, its row is deleted before the new one is
 * created — never left valid alongside the new session. Without this, an
 * attacker who can plant a session id in a victim's browser before they
 * authenticate (session fixation) would hold a valid authenticated
 * session afterward, since the pre-existing cookie would just keep
 * working. Login and OAuth callback are the only callers, so this is
 * the one place rotation needs to happen.
 */
export async function createSession(merchantId: string): Promise<string> {
  const cookieStore = await cookies();
  const existingSessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (existingSessionId) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, existingSessionId));
  }

  const [session] = await db
    .insert(schema.sessions)
    .values({
      merchantId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning();

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

/**
 * Invalidates every session for a merchant except (optionally) one to
 * keep — used on password change (Layer 26-2). A merchant who changes
 * their password because they suspect compromise expects every other
 * session to stop working immediately; leaving old sessions valid would
 * make the password change itself do nothing against the actual threat.
 */
export async function invalidateOtherSessions(merchantId: string, keepSessionId?: string): Promise<void> {
  const condition = keepSessionId
    ? and(eq(schema.sessions.merchantId, merchantId), ne(schema.sessions.id, keepSessionId))
    : eq(schema.sessions.merchantId, merchantId);
  await db.delete(schema.sessions).where(condition);
}

/**
 * Expired sessions are already rejected on read (getSessionMerchant's own
 * expiresAt check) — this is table hygiene, not a security hole, dropping
 * rows nothing will ever successfully authenticate against again.
 * Registered in /api/cron/run alongside the existing sweeps.
 */
export async function sweepExpiredSessions(): Promise<{ swept: number }> {
  const deleted = await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date())).returning({ id: schema.sessions.id });
  return { swept: deleted.length };
}

/** The raw session cookie value, for callers (password change) that need to name "this session" as the one to keep when invalidating the rest. */
export async function getCurrentSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
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
