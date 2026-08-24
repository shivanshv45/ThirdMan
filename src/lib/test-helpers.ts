import { randomUUID } from "crypto";
import { db, schema } from "@/lib/db";

/**
 * Inserts a merchant row satisfying the required email/passwordHash
 * columns, for tests that only care about a valid merchant to attach
 * other rows to. The password hash is a placeholder, never a real one.
 */
export async function createTestMerchant(name: string) {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name,
      email: `${randomUUID()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}
