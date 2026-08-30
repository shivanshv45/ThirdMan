import { lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * A distributed, Postgres-backed sliding-window rate limiter (Layer
 * 26-1). Replaces the earlier in-memory Map, whose own header comment
 * said it plainly: it resets on process restart and doesn't share state
 * across instances, so on a horizontally-scaled deployment (Cloud Run,
 * Vercel) a documented limit of N/minute silently becomes N*instances.
 *
 * Postgres, not Redis — the same reasoning Layer 17 and Layer 13 already
 * applied to reject an external queue/cache: a table plus an atomic
 * conditional UPDATE is a real, durable, transactional primitive this
 * project already knows how to prove correct, and it adds no new
 * infrastructure to a deployment that must stay on free tiers.
 *
 * The window is quantized to windowMs-sized buckets aligned to the
 * epoch (floor(now/windowMs)*windowMs), not a rolling window anchored to
 * each caller's first request — this is what makes "increment atomically"
 * possible as a single upsert rather than a read-modify-write: every
 * caller in the same bucket contends on the same (limitKey, windowStart)
 * row, and Postgres's own unique-index conflict resolution serializes
 * the increment. The tradeoff (a burst can straddle a bucket boundary
 * and briefly allow close to 2x within a short window) is the same one
 * every quantized-window limiter accepts, and is a better fit here than
 * a rolling window would be to implement as one atomic statement.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * key should already include the route (e.g. "chat:1.2.3.4") so limits
 * on different endpoints don't share a bucket. Signature and behaviour
 * are unchanged from the in-memory version — every existing call site
 * (/api/chat, /api/checkout/*, /api/agent/purchase, login, the
 * manifest) is untouched by this swap.
 *
 * Fails closed: if the query itself errors (DB unreachable), the
 * request is denied rather than let through — CLAUDE.md rule 4 applied
 * to abuse protection, not just money decisions. The endpoints this
 * guards call an LLM or create a real Razorpay order on every request;
 * "the guard broke, so let everything through" is the wrong direction
 * to fail in for either of those.
 */
export async function checkRateLimit(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const retryAfterSeconds = Math.ceil((windowStartMs + windowMs - now) / 1000);

  try {
    // Single atomic upsert: insert count=1 for a fresh window, or — on
    // the unique (limitKey, windowStart) conflict — increment only if
    // the post-increment count would still be within the limit. The
    // WHERE clause on the DO UPDATE re-checks the count in the same
    // statement as the write, the identical "never read-then-write"
    // discipline reserveBudget/reserveStock/claimDueTasks already use.
    const result = await db
      .insert(schema.rateLimitWindows)
      .values({ limitKey: key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [schema.rateLimitWindows.limitKey, schema.rateLimitWindows.windowStart],
        set: { count: sql`${schema.rateLimitWindows.count} + 1` },
        setWhere: sql`${schema.rateLimitWindows.count} < ${maxRequests}`,
      })
      .returning({ count: schema.rateLimitWindows.count });

    // A conflict whose setWhere didn't match returns zero rows (Postgres's
    // ON CONFLICT DO UPDATE ... WHERE semantics) rather than the current
    // row — that "no row came back" is itself the deny signal, so no
    // second read is needed to find out why.
    if (result.length === 0) {
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true };
  } catch (err) {
    console.error(`[rate-limit] query failed for key "${key}", denying:`, err);
    return { allowed: false, retryAfterSeconds };
  }
}

/** Best-effort client identifier from request headers — a real deployment behind a trusted proxy should prefer its own forwarded-for parsing, this is a reasonable default for a single-hop deployment. */
export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

/**
 * Drops windows old enough that nothing will ever query them again —
 * table hygiene, not a rate-limit decision (a window outside every
 * caller's windowMs is dead weight the same way rate-limit.ts's old
 * in-memory sweep described itself). Registered in /api/cron/run
 * alongside the existing sweeps. A generous fixed retention (1 hour)
 * covers every windowMs this codebase actually uses; sized once here
 * rather than threaded per-caller, since sweeping too late costs table
 * bloat, never correctness.
 */
const SWEEP_RETENTION_MS = 60 * 60 * 1000;

export async function sweepStaleRateLimitWindows(): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - SWEEP_RETENTION_MS);
  const deleted = await db.delete(schema.rateLimitWindows).where(lt(schema.rateLimitWindows.windowStart, cutoff)).returning({ id: schema.rateLimitWindows.id });
  return { swept: deleted.length };
}
