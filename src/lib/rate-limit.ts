/**
 * A minimal per-key sliding-window rate limiter, in-memory. Deferred at
 * Layer 2 to "a real deployment" — reconsidered here because Layer 4
 * adds public, unauthenticated endpoints that hit the LLM (/api/chat) or
 * create real Razorpay orders (/api/checkout/*) on every call, a more
 * pressing abuse surface than the dashboard/agent routes this was
 * originally deferred for.
 *
 * Resets on process restart and doesn't share state across instances —
 * not a substitute for a real distributed limiter (Redis, a gateway) in
 * a multi-instance deployment. It is a real, working guard against the
 * obvious case (a script hammering one of these routes from one IP)
 * rather than nothing, which is the honest bar for what this layer
 * needs, not a claim of production-grade abuse protection.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Periodically drop stale buckets so this Map doesn't grow unboundedly
// over a long-running process — a bucket outside any window is dead
// weight, not a rate-limit decision waiting to happen.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > SWEEP_INTERVAL_MS) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS).unref();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * key should already include the route (e.g. "chat:1.2.3.4") so limits
 * on different endpoints don't share a bucket.
 */
export function checkRateLimit(key: string, maxRequests: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.ceil((windowMs - (now - bucket.windowStart)) / 1000) };
  }

  bucket.count += 1;
  return { allowed: true };
}

/** Best-effort client identifier from request headers — a real deployment behind a trusted proxy should prefer its own forwarded-for parsing, this is a reasonable default for a single-hop deployment. */
export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}
