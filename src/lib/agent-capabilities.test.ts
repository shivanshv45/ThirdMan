import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireCapability, getAgentCapabilities } from "@/lib/agent-auth";
import { setAgentCapabilities } from "@/lib/dashboard-mutations";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 13-2: capability scoping. Authentication is not authorization —
 * an authenticated, unrevoked, under-cap agent must still hold the
 * specific capability a route/tool requires. Deny by default, and a
 * denial writes a real audit entry naming the missing scope.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__agent_caps_test_${Date.now()}_${Math.random()}__`,
      email: `agent_caps_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: "__agent_caps_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

describe("agent capability scoping", () => {
  let merchantId: string | undefined;
  let agentId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentId = agentId;
    merchantId = undefined;
    agentId = undefined;

    if (currentAgentId) {
      await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, currentAgentId));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("denies by default — a newly created agent with no granted capabilities fails every check", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    expect(await requireCapability(agent, "products:read")).toBe(false);
    expect(await requireCapability(agent, "purchase:create")).toBe(false);

    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    expect(entries.some((e) => e.event === "agent_capability_denied" && e.reason.includes("products:read"))).toBe(true);
    expect(entries.some((e) => e.event === "agent_capability_denied" && e.reason.includes("purchase:create"))).toBe(true);
  });

  it("setAgentCapabilities grants exactly the given set — a full replace, not an incremental add", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    await setAgentCapabilities(merchantId, agent.id, ["products:read", "purchase:create"]);
    expect(await requireCapability(agent, "products:read")).toBe(true);
    expect(await requireCapability(agent, "purchase:create")).toBe(true);
    expect(await requireCapability(agent, "policy:read")).toBe(false);

    // Full replace: dropping purchase:create from the next call removes it.
    await setAgentCapabilities(merchantId, agent.id, ["products:read"]);
    expect(await requireCapability(agent, "products:read")).toBe(true);
    expect(await requireCapability(agent, "purchase:create")).toBe(false);

    const granted = await getAgentCapabilities(agent.id);
    expect(granted).toEqual(["products:read"]);
  });

  it("setAgentCapabilities rejects a value outside the enum silently (filtered, not inserted) rather than erroring the whole request", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const result = await setAgentCapabilities(merchantId, agent.id, [
      "products:read",
      // @ts-expect-error deliberately invalid input, simulating a malformed form submission
      "refund:create",
    ]);

    expect(result).toEqual(["products:read"]);
    const granted = await getAgentCapabilities(agent.id);
    expect(granted).toEqual(["products:read"]);
  });

  it("cross-merchant: setAgentCapabilities refuses to act on another merchant's agent by id", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const merchantB = await makeMerchant();
    try {
      await expect(setAgentCapabilities(merchantB.id, agent.id, ["products:read"])).rejects.toThrow(/not found/i);
      // Confirm nothing was granted despite the attempt.
      expect(await getAgentCapabilities(agent.id)).toEqual([]);
    } finally {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    }
  });

  it("refunds and payouts are not representable at all — no capability string for them exists in the enum", () => {
    const values = schema.agentCapabilityEnum.enumValues as readonly string[];
    expect(values).not.toContain("refund:create");
    expect(values).not.toContain("payout:create");
  });
});
