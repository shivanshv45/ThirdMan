import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { setMerchantAgentTerms, getMerchantAgentTerms } from "@/lib/agent-terms";
import { registerAgent } from "@/lib/agent-registration";
import { authenticateAgent } from "@/lib/agent-auth";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * L21-5/L21-7/L21-8: agent terms are enforced in checkBounds against
 * real rows, not merely stored — and self-serve registration is closed
 * by default, cannot grant a capability the merchant didn't configure,
 * and cannot raise its own cap. No mocks: real DB, real gate calls.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const agentRows = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    const agentIds = agentRows.map((a) => a.id);
    for (const agentId of agentIds) {
      await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agentId));
      await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agentId));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchantAgentTerms).where(eq(schema.merchantAgentTerms.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function makeMerchantWithRazorpay() {
  const merchant = await createTestMerchant("__agent_terms_test__", { withRazorpayCredentials: true });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

describe("merchant_agent_terms enforcement in checkBounds", () => {
  it("denies a self-registered agent with no purchase history when unknownAgentsAllowed is false (the default, no row published)", async () => {
    const merchant = await makeMerchantWithRazorpay();

    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__self_reg_agent__", apiKeyHash: `test_${Date.now()}`, status: "active", registrationSource: "self_registered" })
      .returning();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000,
      spentPaise: 0,
      perTransactionMaxPaise: 50_000,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    const result = await attemptMoneyAction({ agentId: agent.id, merchantId: merchant.id, type: "order_create", amountPaise: 10_000, context: "test" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/unknown agents to transact/i);
  }, 20_000);

  it("does NOT apply unknown-agent gating to a merchant-issued agent, even with no terms published", async () => {
    const merchant = await makeMerchantWithRazorpay();

    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__merchant_issued_agent__", apiKeyHash: `test_${Date.now()}`, status: "active" })
      .returning();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000,
      spentPaise: 0,
      perTransactionMaxPaise: 50_000,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    const result = await attemptMoneyAction({ agentId: agent.id, merchantId: merchant.id, type: "order_create", amountPaise: 10_000, context: "test" });
    expect(result.decision).toBe("allow");
  }, 20_000);

  it("allows a self-registered agent with no history once unknownAgentsAllowed is true", async () => {
    const merchant = await makeMerchantWithRazorpay();
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: [],
      selfRegistrationOpen: false,
      selfRegisterStartingCapPaise: null,
      selfRegisterPerTransactionMaxPaise: null,
    });

    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__self_reg_agent_2__", apiKeyHash: `test_${Date.now()}`, status: "active", registrationSource: "self_registered" })
      .returning();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000,
      spentPaise: 0,
      perTransactionMaxPaise: 50_000,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    const result = await attemptMoneyAction({ agentId: agent.id, merchantId: merchant.id, type: "order_create", amountPaise: 10_000, context: "test" });
    expect(result.decision).toBe("allow");
  }, 20_000);

  it("denies a new self-registered agent's order above the configured new-agent order ceiling", async () => {
    const merchant = await makeMerchantWithRazorpay();
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: 5_000,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: [],
      selfRegistrationOpen: false,
      selfRegisterStartingCapPaise: null,
      selfRegisterPerTransactionMaxPaise: null,
    });

    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__self_reg_agent_3__", apiKeyHash: `test_${Date.now()}`, status: "active", registrationSource: "self_registered" })
      .returning();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000,
      spentPaise: 0,
      perTransactionMaxPaise: 50_000,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    const result = await attemptMoneyAction({ agentId: agent.id, merchantId: merchant.id, type: "order_create", amountPaise: 10_000, context: "test" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/order ceiling/i);
  }, 20_000);

  it("requires a verified mandate above mandateRequiredAbovePaise, for ANY agent (not scoped to self-registered)", async () => {
    const merchant = await makeMerchantWithRazorpay();
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: false,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: 5_000,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: [],
      selfRegistrationOpen: false,
      selfRegisterStartingCapPaise: null,
      selfRegisterPerTransactionMaxPaise: null,
    });

    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__mandate_above_agent__", apiKeyHash: `test_${Date.now()}`, status: "active" })
      .returning();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000,
      spentPaise: 0,
      perTransactionMaxPaise: 50_000,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    const denied = await attemptMoneyAction({ agentId: agent.id, merchantId: merchant.id, type: "order_create", amountPaise: 10_000, context: "test" });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toMatch(/verified AP2 Payment Mandate/i);

    const allowed = await attemptMoneyAction({ agentId: agent.id, merchantId: merchant.id, type: "order_create", amountPaise: 10_000, context: "test", mandateVerified: true });
    expect(allowed.decision).toBe("allow");
  }, 20_000);
});

describe("self-serve agent registration (POST /api/agent/register)", () => {
  it("is closed by default when no terms are published", async () => {
    const merchant = await makeMerchantWithRazorpay();
    const result = await registerAgent(merchant.id, "a stranger's agent", "1.2.3.4");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not accept self-registered/i);
  });

  it("is closed when terms exist but selfRegistrationOpen is false", async () => {
    const merchant = await makeMerchantWithRazorpay();
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: ["products:read"],
      selfRegistrationOpen: false,
      selfRegisterStartingCapPaise: 10_000,
      selfRegisterPerTransactionMaxPaise: 5_000,
    });

    const result = await registerAgent(merchant.id, "a stranger's agent", "1.2.3.4");
    expect(result.ok).toBe(false);
  });

  it("refuses to open registration without a starting cap and per-transaction max", async () => {
    const merchant = await makeMerchantWithRazorpay();
    await expect(
      setMerchantAgentTerms({
        merchantId: merchant.id,
        unknownAgentsAllowed: false,
        newAgentOrderCeilingPaise: null,
        mandateRequiredAbovePaise: null,
        negotiationOpenToAgents: false,
        selfRegisterDefaultCapabilities: [],
        selfRegistrationOpen: true,
        selfRegisterStartingCapPaise: null,
        selfRegisterPerTransactionMaxPaise: null,
      }),
    ).rejects.toThrow(/starting cap/i);
  });

  it("issues exactly the merchant's configured cap and default capabilities — never more, never a hardcoded default", async () => {
    const merchant = await makeMerchantWithRazorpay();
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: ["products:read", "policy:read"],
      selfRegistrationOpen: true,
      selfRegisterStartingCapPaise: 25_000,
      selfRegisterPerTransactionMaxPaise: 10_000,
    });

    const result = await registerAgent(merchant.id, "a real stranger's agent", "5.6.7.8");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.agent.registrationSource).toBe("self_registered");
    expect(result.agent.registeredIp).toBe("5.6.7.8");

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, result.agent.id));
    expect(cap.capPaise).toBe(25_000);
    expect(cap.perTransactionMaxPaise).toBe(10_000);

    const caps = await db.select().from(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, result.agent.id));
    const grantedNames = caps.map((c) => c.capability).sort();
    expect(grantedNames).toEqual(["policy:read", "products:read"]);
    // Never purchase:create by construction here — it was never in the configured default set.
    expect(grantedNames).not.toContain("purchase:create");

    // The issued key genuinely authenticates as this new agent.
    const authed = await authenticateAgent(result.rawKey);
    expect(authed?.id).toBe(result.agent.id);
  });

  it("negotiation:create can never land in the default set unless negotiationOpenToAgents is also true", async () => {
    const merchant = await makeMerchantWithRazorpay();
    const saved = await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: ["negotiation:create", "products:read"],
      selfRegistrationOpen: true,
      selfRegisterStartingCapPaise: 10_000,
      selfRegisterPerTransactionMaxPaise: 5_000,
    });
    expect(saved.selfRegisterDefaultCapabilities).toEqual(["products:read"]);

    const fetched = await getMerchantAgentTerms(merchant.id);
    expect(fetched?.selfRegisterDefaultCapabilities).toEqual(["products:read"]);
  });
});
