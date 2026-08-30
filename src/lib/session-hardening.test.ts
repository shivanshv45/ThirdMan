import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { invalidateOtherSessions, sweepExpiredSessions } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { changePassword } from "@/lib/dashboard-mutations";

/**
 * Layer 26-2/26-7: session rotation and expiry sweep. createSession()
 * itself needs next/headers' cookies() (a request scope this test file
 * doesn't have), so rotation on login is exercised at the level below
 * it — invalidateOtherSessions, the same function createSession's own
 * rotation and changePassword's own invalidation both call — plus a
 * direct proof that changePassword (the real end-to-end path a merchant
 * uses) does invalidate every other session but its own.
 */

const createdMerchantIds: string[] = [];

async function makeMerchant(passwordHash: string) {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: "__session_hardening_test__",
      email: `session_hardening_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash,
    })
    .returning();
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makeSession(merchantId: string) {
  const [session] = await db
    .insert(schema.sessions)
    .values({ merchantId, expiresAt: new Date(Date.now() + 60_000) })
    .returning();
  return session;
}

afterEach(async () => {
  for (const merchantId of createdMerchantIds.splice(0)) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.sessions).where(eq(schema.sessions.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
});

describe("invalidateOtherSessions", () => {
  it("a session id present before the call is invalid after it (rotation's underlying primitive)", async () => {
    const merchant = await makeMerchant("irrelevant:hash");
    const fixatedSession = await makeSession(merchant.id);

    await invalidateOtherSessions(merchant.id);

    const remaining = await db.select().from(schema.sessions).where(eq(schema.sessions.id, fixatedSession.id));
    expect(remaining).toHaveLength(0);
  });

  it("keeps the named session while invalidating every other one for the same merchant", async () => {
    const merchant = await makeMerchant("irrelevant:hash");
    const keep = await makeSession(merchant.id);
    const other1 = await makeSession(merchant.id);
    const other2 = await makeSession(merchant.id);

    await invalidateOtherSessions(merchant.id, keep.id);

    const kept = await db.select().from(schema.sessions).where(eq(schema.sessions.id, keep.id));
    const others = await db.select().from(schema.sessions).where(eq(schema.sessions.merchantId, merchant.id));

    expect(kept).toHaveLength(1);
    expect(others.map((s) => s.id).sort()).toEqual([keep.id].sort());
    expect(others.some((s) => s.id === other1.id)).toBe(false);
    expect(others.some((s) => s.id === other2.id)).toBe(false);
  });

  it("never touches another merchant's sessions", async () => {
    const merchantA = await makeMerchant("irrelevant:hash");
    const merchantB = await makeMerchant("irrelevant:hash");
    const sessionB = await makeSession(merchantB.id);

    await invalidateOtherSessions(merchantA.id);

    const stillThere = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionB.id));
    expect(stillThere).toHaveLength(1);
  });
});

describe("changePassword invalidates other sessions", () => {
  it("a real password change invalidates every session except the one making the request", async () => {
    const originalHash = await hashPassword("original-password-123");
    const merchant = await makeMerchant(originalHash);
    const currentSession = await makeSession(merchant.id);
    const otherSession = await makeSession(merchant.id);

    await changePassword(merchant.id, currentSession.id, "original-password-123", "brand-new-password-456");

    const currentRow = await db.select().from(schema.sessions).where(eq(schema.sessions.id, currentSession.id));
    const otherRow = await db.select().from(schema.sessions).where(eq(schema.sessions.id, otherSession.id));

    expect(currentRow).toHaveLength(1);
    expect(otherRow).toHaveLength(0);
  });

  it("rejects a change with the wrong current password, touching no sessions", async () => {
    const originalHash = await hashPassword("original-password-123");
    const merchant = await makeMerchant(originalHash);
    const session = await makeSession(merchant.id);

    await expect(changePassword(merchant.id, session.id, "totally-wrong", "brand-new-password-456")).rejects.toThrow();

    const stillThere = await db.select().from(schema.sessions).where(eq(schema.sessions.id, session.id));
    expect(stillThere).toHaveLength(1);
  });
});

describe("sweepExpiredSessions", () => {
  it("removes an expired session, leaves an unexpired one", async () => {
    const merchant = await makeMerchant("irrelevant:hash");
    const [expired] = await db
      .insert(schema.sessions)
      .values({ merchantId: merchant.id, expiresAt: new Date(Date.now() - 60_000) })
      .returning();
    const unexpired = await makeSession(merchant.id);

    await sweepExpiredSessions();

    const expiredRow = await db.select().from(schema.sessions).where(eq(schema.sessions.id, expired.id));
    const unexpiredRow = await db.select().from(schema.sessions).where(eq(schema.sessions.id, unexpired.id));

    expect(expiredRow).toHaveLength(0);
    expect(unexpiredRow).toHaveLength(1);
  });
});
