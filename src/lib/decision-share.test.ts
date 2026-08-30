import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createDecisionShareToken, revokeDecisionShareToken, resolveShareToken, getShareTokensForDecision } from "@/lib/decision-share";

/**
 * Layer 25-4: the decision permalink's share mechanism. A decision is
 * not public data by default — these tests prove the token is the ONLY
 * path around the merchant-session scope, that it resolves to exactly
 * the decision it was minted for (never any other), and that id
 * enumeration fails closed, matching isolation.test.ts's own standard
 * elsewhere in this codebase.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__share_test_${Date.now()}_${Math.random()}__`,
      email: `share_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

async function makeAuditRow(merchantId: string) {
  const [row] = await db
    .insert(schema.auditLog)
    .values({ merchantId, actor: "agent", event: "money_action_attempt:order_create", decision: "deny", reason: "__share_test_denial__" })
    .returning();
  return row;
}

describe("decision-share.ts", () => {
  const merchantIds: string[] = [];

  afterEach(async () => {
    const currentMerchantIds = [...merchantIds];
    merchantIds.length = 0;
    for (const merchantId of currentMerchantIds) {
      await db.delete(schema.decisionShareTokens).where(eq(schema.decisionShareTokens.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("a minted token resolves to exactly the decision it was created for", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const auditRow = await makeAuditRow(merchant.id);

    const token = await createDecisionShareToken(merchant.id, auditRow.id);
    const resolved = await resolveShareToken(token);

    expect(resolved).not.toBeNull();
    expect(resolved!.merchantId).toBe(merchant.id);
    expect(resolved!.auditLogId).toBe(auditRow.id);
  });

  it("a fabricated token resolves to nothing — enumeration fails closed", async () => {
    const resolved = await resolveShareToken("share_this-token-was-never-minted");
    expect(resolved).toBeNull();
  });

  it("creating a token for a decision that doesn't belong to the given merchant is refused", async () => {
    const merchantA = await makeMerchant();
    merchantIds.push(merchantA.id);
    const merchantB = await makeMerchant();
    merchantIds.push(merchantB.id);
    const auditRowA = await makeAuditRow(merchantA.id);

    await expect(createDecisionShareToken(merchantB.id, auditRowA.id)).rejects.toThrow(/not found/i);
  });

  it("a revoked token no longer resolves, and revoking is scoped to the owning merchant", async () => {
    const merchantA = await makeMerchant();
    merchantIds.push(merchantA.id);
    const merchantB = await makeMerchant();
    merchantIds.push(merchantB.id);
    const auditRowA = await makeAuditRow(merchantA.id);

    const token = await createDecisionShareToken(merchantA.id, auditRowA.id);

    // B cannot revoke A's token by supplying A's token value.
    await revokeDecisionShareToken(merchantB.id, token);
    expect(await resolveShareToken(token)).not.toBeNull();

    // A can revoke its own.
    await revokeDecisionShareToken(merchantA.id, token);
    expect(await resolveShareToken(token)).toBeNull();
  });

  it("getShareTokensForDecision is merchant-scoped — B sees none of A's tokens", async () => {
    const merchantA = await makeMerchant();
    merchantIds.push(merchantA.id);
    const merchantB = await makeMerchant();
    merchantIds.push(merchantB.id);
    const auditRowA = await makeAuditRow(merchantA.id);

    await createDecisionShareToken(merchantA.id, auditRowA.id);

    const tokensForB = await getShareTokensForDecision(merchantB.id, auditRowA.id);
    expect(tokensForB.length).toBe(0);

    const tokensForA = await getShareTokensForDecision(merchantA.id, auditRowA.id);
    expect(tokensForA.length).toBe(1);
  });
});
