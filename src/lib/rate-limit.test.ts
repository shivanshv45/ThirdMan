import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkRateLimit, getClientIp, sweepStaleRateLimitWindows } from "@/lib/rate-limit";

/**
 * Real DB, no mocks — the distributed limiter's whole point is that its
 * state lives in Postgres, so a test against an in-memory stand-in would
 * prove nothing about the property that actually matters (Layer 26-7).
 */

const testKeys: string[] = [];
function freshKey(label: string): string {
  const key = `test-${label}-${Date.now()}-${Math.random()}`;
  testKeys.push(key);
  return key;
}

afterEach(async () => {
  for (const key of testKeys.splice(0)) {
    await db.delete(schema.rateLimitWindows).where(eq(schema.rateLimitWindows.limitKey, key));
  }
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit, then denies the next one within the window", async () => {
    const key = freshKey("basic");
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);
    }
    const fourth = await checkRateLimit(key, 3, 60_000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("different keys have independent windows", async () => {
    const keyA = freshKey("a");
    const keyB = freshKey("b");
    expect((await checkRateLimit(keyA, 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(keyA, 1, 60_000)).allowed).toBe(false);
    // keyB is untouched by keyA's exhaustion.
    expect((await checkRateLimit(keyB, 1, 60_000)).allowed).toBe(true);
  });

  it("resets once the quantized window rolls over", async () => {
    const key = freshKey("window");
    // A short window so the test can wait past a full boundary quickly
    // without depending on wall-clock alignment tricks.
    const windowMs = 200;
    const first = await checkRateLimit(key, 1, windowMs);
    expect(first.allowed).toBe(true);
    // Wait past two full window boundaries to be robust against where in
    // the current window the test happened to start.
    await new Promise((resolve) => setTimeout(resolve, windowMs * 2 + 50));
    const afterRollover = await checkRateLimit(key, 1, windowMs);
    expect(afterRollover.allowed).toBe(true);
  });

  /**
   * The concurrency proof this layer exists for: N genuinely simultaneous
   * requests against a limit of M land at exactly M allowed — the same
   * shape as gate.ts's own 20-concurrent-against-a-cap-of-5 test. Proves
   * the atomic onConflictDoUpdate/setWhere upsert, not a read-then-write,
   * is what's actually enforcing the bound under real contention.
   */
  it("N simultaneous requests against a limit of M land at exactly M allowed", async () => {
    const key = freshKey("concurrent");
    const N = 20;
    const M = 5;

    const results = await Promise.all(Array.from({ length: N }, () => checkRateLimit(key, M, 60_000)));
    const allowedCount = results.filter((r) => r.allowed).length;

    expect(allowedCount).toBe(M);
  });

  /**
   * Two independent callers sharing a key see the same counter — this
   * is what "genuinely shared" means for a limiter with no in-process
   * state at all: nothing here is per-process, so two calls interleaved
   * (as two separate instances' requests would be) still contend on one
   * row. Distinct from the concurrency test above, which proves
   * atomicity; this proves the state itself isn't partitioned by caller.
   */
  it("state is genuinely shared across independent callers, not partitioned per caller", async () => {
    const key = freshKey("shared");
    const callerA = await checkRateLimit(key, 2, 60_000);
    const callerB = await checkRateLimit(key, 2, 60_000);
    const callerAAgain = await checkRateLimit(key, 2, 60_000);

    expect(callerA.allowed).toBe(true);
    expect(callerB.allowed).toBe(true);
    // The limit of 2 was already reached by A and B combined — a third
    // call from "the same caller as the first" is denied exactly because
    // the counter isn't scoped to who's asking.
    expect(callerAAgain.allowed).toBe(false);
  });

  it("denies with maxRequests 0 once a window row already exists (the plain INSERT only bypasses setWhere on the very first request)", async () => {
    const key = freshKey("zero-max");
    // The first call for a fresh (key, window) always succeeds via the
    // plain INSERT branch — setWhere only gates the ON CONFLICT UPDATE
    // branch, so it can't stop a row from being created in the first
    // place. Every call after that one contends on the same row and
    // setWhere (count < 0) can never be true, so it denies from then on.
    await checkRateLimit(key, 0, 60_000);
    const result = await checkRateLimit(key, 0, 60_000);
    expect(result.allowed).toBe(false);
  });
});

describe("sweepStaleRateLimitWindows", () => {
  it("removes windows older than the retention period, leaves recent ones", async () => {
    const staleKey = freshKey("stale");
    const freshKeyName = freshKey("fresh");

    await db.insert(schema.rateLimitWindows).values({
      limitKey: staleKey,
      windowStart: new Date(Date.now() - 2 * 60 * 60 * 1000),
      count: 1,
    });
    await db.insert(schema.rateLimitWindows).values({
      limitKey: freshKeyName,
      windowStart: new Date(),
      count: 1,
    });

    await sweepStaleRateLimitWindows();

    const staleRows = await db.select().from(schema.rateLimitWindows).where(eq(schema.rateLimitWindows.limitKey, staleKey));
    const freshRows = await db.select().from(schema.rateLimitWindows).where(eq(schema.rateLimitWindows.limitKey, freshKeyName));

    expect(staleRows).toHaveLength(0);
    expect(freshRows).toHaveLength(1);
  });
});

describe("getClientIp", () => {
  it("prefers x-forwarded-for, taking the first entry", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": "9.9.9.9" });
    expect(getClientIp(headers)).toBe("9.9.9.9");
  });

  it("returns 'unknown' when neither header is present", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});
