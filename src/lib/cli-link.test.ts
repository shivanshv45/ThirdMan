import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createCliLinkToken, redeemCliLinkToken, sweepExpiredCliLinkTokens } from "@/lib/cli-link";

/**
 * Layer 20-6: the CLI's account-linking token. Single-use (deleted on
 * redemption, unlike decision-share.ts's revocable-but-standing tokens)
 * since this one grants a real mutation — creating an agent key. These
 * tests prove: real redemption creates a real agent with the minimum
 * capability set, a second redemption of the same token fails closed,
 * an expired token is refused, and the origin allowlist add is real.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__cli_link_test_${Date.now()}_${Math.random()}__`,
      email: `cli_link_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

describe("cli-link.ts", () => {
  const merchantIds: string[] = [];

  afterEach(async () => {
    const currentMerchantIds = [...merchantIds];
    merchantIds.length = 0;
    for (const merchantId of currentMerchantIds) {
      const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      for (const agent of agents) {
        await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agent.id));
      }
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchantId));
      await db.delete(schema.cliLinkTokens).where(eq(schema.cliLinkTokens.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("redeeming a real token creates an agent with exactly products:read and purchase:create", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const { token } = await createCliLinkToken(merchant.id);
    const result = await redeemCliLinkToken(token, "My CLI agent", null);

    expect(result).not.toBeNull();
    expect(result!.merchantId).toBe(merchant.id);
    expect(result!.rawKey).toBeTruthy();

    const caps = await db.select().from(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, result!.agentId));
    expect(caps.map((c) => c.capability).sort()).toEqual(["products:read", "purchase:create"].sort());
  });

  it("a token can be redeemed exactly once — the second redemption fails closed", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const { token } = await createCliLinkToken(merchant.id);
    const first = await redeemCliLinkToken(token, "Agent one", null);
    expect(first).not.toBeNull();

    const second = await redeemCliLinkToken(token, "Agent two", null);
    expect(second).toBeNull();
  });

  it("a fabricated token is refused", async () => {
    const result = await redeemCliLinkToken("cli_this-token-was-never-minted", "Agent", null);
    expect(result).toBeNull();
  });

  it("an expired token is refused even though it still exists", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const token = "cli_test_expired_token";
    await db.insert(schema.cliLinkTokens).values({ token, merchantId: merchant.id, expiresAt: new Date(Date.now() - 1000) });

    const result = await redeemCliLinkToken(token, "Agent", null);
    expect(result).toBeNull();
  });

  it("redeeming with an origin adds it to the embed allowlist, audited", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const { token } = await createCliLinkToken(merchant.id);
    const result = await redeemCliLinkToken(token, "Agent", "https://shop.example.com");
    expect(result).not.toBeNull();

    const [config] = await db.select().from(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchant.id));
    expect(config.allowedOrigins).toContain("https://shop.example.com");
  });

  it("sweepExpiredCliLinkTokens removes only expired tokens", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    await db.insert(schema.cliLinkTokens).values({ token: "cli_test_sweep_expired", merchantId: merchant.id, expiresAt: new Date(Date.now() - 1000) });
    const { token: freshToken } = await createCliLinkToken(merchant.id);

    const { swept } = await sweepExpiredCliLinkTokens();
    expect(swept).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(schema.cliLinkTokens).where(eq(schema.cliLinkTokens.token, freshToken));
    expect(remaining.length).toBe(1);
  });
});
