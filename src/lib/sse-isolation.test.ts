import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { getAuditTrail } from "@/lib/dashboard";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 15-3: the live decision stream is an authorization surface like
 * any other, and the property that matters is that a merchant's stream
 * can only ever carry that merchant's own rows.
 *
 * The route itself resolves the session merchant and hands exactly that
 * id to getAuditTrail, so the isolation guarantee lives in
 * getAuditTrail's own scoping, which is what this file tests against
 * real rows in the real database. An earlier version of this file
 * mocked getSessionMerchant and getAuditTrail and asserted the route
 * passed one to the other, which tested the wiring while assuming away
 * the thing that could actually leak, and violated this project's
 * zero-mocks rule besides.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function makeMerchant(label: string) {
  const merchant = await createTestMerchant(`__sse_isolation_${label}__`);
  createdMerchantIds.push(merchant.id);
  return merchant;
}

describe("SSE decision stream: tenant isolation", () => {
  it("never returns another merchant's audit rows, checked by id not by empty list", async () => {
    const alice = await makeMerchant("alice");
    const bob = await makeMerchant("bob");

    await logAuditEntry({
      merchantId: alice.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Alice's own refusal, must never appear on Bob's stream.",
    });
    await logAuditEntry({
      merchantId: bob.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "allow",
      reason: "Bob's own decision.",
    });

    const aliceTrail = await getAuditTrail(alice.id, 25);
    const bobTrail = await getAuditTrail(bob.id, 25);

    // Both merchants have real rows, so an empty result cannot be what
    // makes this pass. The assertion is on identity, not on absence.
    expect(aliceTrail.length).toBeGreaterThan(0);
    expect(bobTrail.length).toBeGreaterThan(0);

    const aliceIds = new Set(aliceTrail.map((e) => e.id));
    const bobIds = new Set(bobTrail.map((e) => e.id));
    for (const id of aliceIds) expect(bobIds.has(id)).toBe(false);

    expect(aliceTrail.every((e) => e.reason.includes("Alice's own"))).toBe(true);
    expect(bobTrail.every((e) => e.reason.includes("Bob's own"))).toBe(true);
  });

  it("bounds a single read to the requested limit, so one tick cannot balloon", async () => {
    const merchant = await makeMerchant("limit");

    for (let i = 0; i < 8; i++) {
      await logAuditEntry({
        merchantId: merchant.id,
        actor: "agent",
        event: "money_action_attempt:order_create",
        decision: "deny",
        reason: `Refusal ${i}.`,
      });
    }

    const limited = await getAuditTrail(merchant.id, 3);
    expect(limited).toHaveLength(3);
  });

  it("returns newest first, so the stream's freshness cursor advances correctly", async () => {
    const merchant = await makeMerchant("order");

    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Older entry.",
    });
    // A real gap, so the ordering assertion is not decided by a tie.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "allow",
      reason: "Newer entry.",
    });

    const trail = await getAuditTrail(merchant.id, 25);
    expect(trail[0].reason).toBe("Newer entry.");
    expect(new Date(trail[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(trail[1].createdAt).getTime(),
    );
  });
});
