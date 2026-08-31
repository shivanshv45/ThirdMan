import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { verifyLoginCredentials } from "@/app/(auth)/login/actions";

/**
 * Layer 26-7: login timing must not distinguish a missing account from
 * a wrong password — measured directly, not asserted by inspection.
 * scrypt's own cost dwarfs everything else in this path, so a real
 * account-exists branch that skipped the comparison would show up as a
 * clear, many-x timing gap, not a subtle one — this test has margin.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds.splice(0)) {
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
});

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe("verifyLoginCredentials — timing", () => {
  it("a missing account and a wrong password on a real account cost roughly the same", async () => {
    const passwordHash = await hashPassword("the-real-password-123");
    const [merchant] = await db
      .insert(schema.merchants)
      .values({ name: "__login_timing_test__", email: `login_timing_${Date.now()}_${Math.random()}@test.invalid`, passwordHash })
      .returning();
    createdMerchantIds.push(merchant.id);

    const ROUNDS = 12;
    const missingAccountTimings: number[] = [];
    const wrongPasswordTimings: number[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      missingAccountTimings.push(await timeIt(() => verifyLoginCredentials(`no_such_account_${Date.now()}_${i}@test.invalid`, "whatever-password")));
      wrongPasswordTimings.push(await timeIt(() => verifyLoginCredentials(merchant.email, "definitely-the-wrong-password")));
    }

    const median = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const missingMedian = median(missingAccountTimings);
    const wrongMedian = median(wrongPasswordTimings);

    // Both branches run one real scrypt derivation — allow generous
    // slack for real machine/DB jitter, but a branch that skipped the
    // comparison entirely would be an order of magnitude faster, not a
    // fraction slower, so this bound has real margin to catch that.
    const ratio = Math.max(missingMedian, wrongMedian) / Math.min(missingMedian, wrongMedian);
    expect(ratio).toBeLessThan(3);
  }, 30_000);

  it("both branches return valid: false, never distinguishing the two cases in their result shape either", async () => {
    const passwordHash = await hashPassword("the-real-password-123");
    const [merchant] = await db
      .insert(schema.merchants)
      .values({ name: "__login_timing_test_2__", email: `login_timing_2_${Date.now()}_${Math.random()}@test.invalid`, passwordHash })
      .returning();
    createdMerchantIds.push(merchant.id);

    const missing = await verifyLoginCredentials(`no_such_account_${Date.now()}@test.invalid`, "whatever");
    const wrong = await verifyLoginCredentials(merchant.email, "wrong-password");

    expect(missing.valid).toBe(false);
    expect(wrong.valid).toBe(false);
  }, 20_000);
});
