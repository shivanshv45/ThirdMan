import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Per-account login backoff (Layer 26-3) — deliberately not a lockout.
 * The existing IP-based rate limit (login/actions.ts's own
 * checkRateLimit call) misses the distributed case: many IPs, one
 * account, which is exactly the shape a real credential-stuffing run
 * takes. This adds an account-keyed layer on top of it.
 *
 * A lockout was rejected outright: it hands an attacker a
 * denial-of-service tool, since anyone who knows a merchant's email
 * could lock them out of their own dashboard by failing a few times on
 * purpose — worse than the attack it prevents for a merchant who may
 * need their dashboard during a live payment incident. This also
 * violates this codebase's own "silence is not consent" principle: an
 * attacker's action would become a decision the merchant never made.
 *
 * The shape: a number of free attempts before any delay applies (a
 * human mistyping twice or three times notices nothing), then a delay
 * before the next attempt that grows exponentially and is capped, and a
 * counter that decays with time so there is no state a merchant can be
 * permanently stuck in.
 */

export const FREE_ATTEMPTS = 3;
const BASE_DELAY_SECONDS = 2;
const MAX_DELAY_SECONDS = 60;
// A failure this long ago no longer counts toward the backoff — the
// decay that makes this "never permanent." Chosen well above
// MAX_DELAY_SECONDS so a real attacker's sustained run still pays the
// full curve, while an old, resolved incident stops mattering.
const DECAY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Pure function: given a number of recent failed attempts, how many
 * seconds must elapse since the last failure before another attempt is
 * allowed. Attempts within FREE_ATTEMPTS cost nothing; beyond that the
 * delay doubles each time, capped at MAX_DELAY_SECONDS. No input
 * produces an unbounded or permanent delay.
 */
export function requiredDelaySeconds(failedAttempts: number): number {
  if (failedAttempts <= FREE_ATTEMPTS) return 0;
  const exponent = failedAttempts - FREE_ATTEMPTS - 1;
  const delay = BASE_DELAY_SECONDS * 2 ** exponent;
  return Math.min(delay, MAX_DELAY_SECONDS);
}

function exemptEmails(): Set<string> {
  const raw = env.AUTH_THROTTLE_EXEMPT_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface ThrottleCheck {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Checks whether a login attempt for this email is currently throttled,
 * without recording anything — call before attempting verification.
 * Decayed state (last failure outside DECAY_WINDOW_MS) is treated as no
 * state at all, matching recordFailure's own decay reset below.
 */
export async function checkLoginThrottle(email: string): Promise<ThrottleCheck> {
  if (exemptEmails().has(email.toLowerCase())) return { allowed: true };

  const [row] = await db.select().from(schema.loginThrottleState).where(eq(schema.loginThrottleState.email, email));
  if (!row) return { allowed: true };

  const sinceLastFailureMs = Date.now() - row.lastFailedAt.getTime();
  if (sinceLastFailureMs >= DECAY_WINDOW_MS) return { allowed: true };

  const delaySeconds = requiredDelaySeconds(row.failedAttempts);
  const elapsedSeconds = sinceLastFailureMs / 1000;
  if (elapsedSeconds >= delaySeconds) return { allowed: true };

  return { allowed: false, retryAfterSeconds: Math.ceil(delaySeconds - elapsedSeconds) };
}

/**
 * Records a failed attempt. A failure outside the decay window resets
 * the counter to 1 rather than continuing to accumulate — decay is
 * enforced here, at write time, not just read at check time, so the
 * stored failedAttempts never silently outlives its own window. This
 * isn't a money bound, so a plain conditional-write (not an atomic
 * single-statement increment) is an acceptable, honest tradeoff: the
 * worst a lost race does is under-count one failed attempt, which only
 * ever makes the backoff slightly more lenient, never a bypass of a
 * real bound.
 */
export async function recordLoginFailure(email: string): Promise<{ failedAttempts: number }> {
  const [existing] = await db.select().from(schema.loginThrottleState).where(eq(schema.loginThrottleState.email, email));

  const decayed = !existing || Date.now() - existing.lastFailedAt.getTime() >= DECAY_WINDOW_MS;
  const nextAttempts = decayed ? 1 : existing.failedAttempts + 1;

  await db
    .insert(schema.loginThrottleState)
    .values({ email, failedAttempts: nextAttempts, lastFailedAt: sql`now()` })
    .onConflictDoUpdate({
      target: schema.loginThrottleState.email,
      set: { failedAttempts: nextAttempts, lastFailedAt: sql`now()` },
    });

  return { failedAttempts: nextAttempts };
}

/** A successful login clears the account's throttle state entirely. */
export async function clearLoginThrottle(email: string): Promise<void> {
  await db.delete(schema.loginThrottleState).where(eq(schema.loginThrottleState.email, email));
}
