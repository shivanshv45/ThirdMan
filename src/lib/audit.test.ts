import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry, getRecentAuditEntries } from "@/lib/audit";
import { createTestMerchant } from "@/lib/test-helpers";

describe("logAuditEntry", () => {
  const createdMerchantIds: string[] = [];

  afterAll(async () => {
    // Scoped to this file's own event names, not a blanket delete, since
    // vitest runs separate test files concurrently by default and an
    // unscoped delete would race with another file's in-flight rows.
    await db.delete(schema.auditLog).where(eq(schema.auditLog.event, "unit_test_write"));
    for (const id of createdMerchantIds) {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
    }
  });

  it("writes an entry and reads it back", async () => {
    const merchant = await createTestMerchant("__audit_test_merchant__");
    createdMerchantIds.push(merchant.id);

    await logAuditEntry({
      merchantId: merchant.id,
      actor: "system",
      event: "unit_test_write",
      decision: "allow",
      reason: "This is a test entry written by audit.test.ts.",
      boundApplied: "none",
    });

    const entries = await getRecentAuditEntries(merchant.id, 10);
    const found = entries.find((e) => e.event === "unit_test_write");

    expect(found).toBeDefined();
    expect(found?.reason).toBe(
      "This is a test entry written by audit.test.ts.",
    );
    expect(found?.decision).toBe("allow");
  });

  it("rejects an empty reason", async () => {
    const merchant = await createTestMerchant("__audit_test_merchant__");
    createdMerchantIds.push(merchant.id);

    await expect(
      logAuditEntry({
        merchantId: merchant.id,
        actor: "system",
        event: "should_not_write",
        decision: "deny",
        reason: "   ",
      }),
    ).rejects.toThrow(/reason must be non-empty/);
  });

  it("does not throw when the underlying write fails", async () => {
    const merchant = await createTestMerchant("__audit_test_merchant__");
    createdMerchantIds.push(merchant.id);

    // Inserting a value that violates the enum constraint triggers a
    // genuine DB-level failure, exercising the same catch path a real
    // connection failure would take.
    await expect(
      logAuditEntry({
        merchantId: merchant.id,
        // @ts-expect-error intentionally invalid actor to force a DB-level failure
        actor: "not_a_real_actor",
        event: "should_be_swallowed",
        decision: "allow",
        reason: "This write is expected to fail at the DB layer.",
      }),
    ).resolves.toBeUndefined();
  });
});
