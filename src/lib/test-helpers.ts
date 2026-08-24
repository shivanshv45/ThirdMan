import { randomUUID } from "crypto";
import { db, schema } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Inserts a merchant row satisfying the required email/passwordHash
 * columns, for tests that only care about a valid merchant to attach
 * other rows to. The password hash is a placeholder, never a real one.
 *
 * Pass withRazorpayCredentials: true for tests that drive a real
 * purchase through the gate — checkBounds denies any merchant with no
 * connected Razorpay account (Layer 2-2), so those need real credentials.
 */
export async function createTestMerchant(name: string, opts: { withRazorpayCredentials?: boolean } = {}) {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name,
      email: `${randomUUID()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      ...(opts.withRazorpayCredentials && {
        razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
        razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
      }),
    })
    .returning();
  return merchant;
}
