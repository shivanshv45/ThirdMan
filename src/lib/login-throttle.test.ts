import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requiredDelaySeconds, checkLoginThrottle, recordLoginFailure, clearLoginThrottle, FREE_ATTEMPTS } from "@/lib/login-throttle";

const testEmails: string[] = [];
function freshEmail(): string {
  const email = `throttle_${Date.now()}_${Math.random()}@test.invalid`;
  testEmails.push(email);
  return email;
}

afterEach(async () => {
  for (const email of testEmails.splice(0)) {
    await db.delete(schema.loginThrottleState).where(eq(schema.loginThrottleState.email, email));
  }
});

describe("requiredDelaySeconds — pure function", () => {
  it("costs nothing for the free attempts", () => {
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      expect(requiredDelaySeconds(i)).toBe(0);
    }
  });

  it("grows monotonically once past the free attempts", () => {
    let previous = requiredDelaySeconds(FREE_ATTEMPTS + 1);
    for (let n = FREE_ATTEMPTS + 2; n < FREE_ATTEMPTS + 10; n++) {
      const delay = requiredDelaySeconds(n);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it("is capped — no input produces an unbounded or permanent delay", () => {
    const MAX_DELAY_SECONDS = 60;
    for (const n of [FREE_ATTEMPTS + 10, 100, 10_000, 1_000_000]) {
      expect(requiredDelaySeconds(n)).toBeLessThanOrEqual(MAX_DELAY_SECONDS);
      expect(Number.isFinite(requiredDelaySeconds(n))).toBe(true);
    }
  });
});

describe("checkLoginThrottle / recordLoginFailure — real DB", () => {
  it("allows the free attempts with no delay recorded", async () => {
    const email = freshEmail();
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      const check = await checkLoginThrottle(email);
      expect(check.allowed).toBe(true);
      await recordLoginFailure(email);
    }
  });

  it("throttles once the free attempts are exhausted, until the delay elapses", async () => {
    const email = freshEmail();
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) {
      await recordLoginFailure(email);
    }
    // Pin lastFailedAt to "now" right after seeding rather than trusting
    // it stayed within the delay window on its own — the sequence of
    // real DB round trips above can itself take longer than the smaller
    // end of the backoff curve, which would make this assertion flaky
    // for a reason that has nothing to do with the throttle logic itself.
    await db.update(schema.loginThrottleState).set({ lastFailedAt: new Date() }).where(eq(schema.loginThrottleState.email, email));

    const check = await checkLoginThrottle(email);
    expect(check.allowed).toBe(false);
    expect(check.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("clearLoginThrottle removes all throttle state (a successful login resets it)", async () => {
    const email = freshEmail();
    for (let i = 0; i < FREE_ATTEMPTS + 3; i++) {
      await recordLoginFailure(email);
    }
    await clearLoginThrottle(email);

    const check = await checkLoginThrottle(email);
    expect(check.allowed).toBe(true);
    const row = await db.select().from(schema.loginThrottleState).where(eq(schema.loginThrottleState.email, email));
    expect(row).toHaveLength(0);
  });

  it("decays — a failure recorded as if long ago is treated as no state at all, never a permanent lock", async () => {
    const email = freshEmail();
    for (let i = 0; i < FREE_ATTEMPTS + 5; i++) {
      await recordLoginFailure(email);
    }
    // Backdate the last failure past the decay window directly — the
    // real decay window (15 minutes) is too long to wait out in a test.
    await db
      .update(schema.loginThrottleState)
      .set({ lastFailedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(schema.loginThrottleState.email, email));

    const check = await checkLoginThrottle(email);
    expect(check.allowed).toBe(true);
  });
});
