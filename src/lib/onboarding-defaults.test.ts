import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { seedOnboardingDefaults } from "./onboarding-defaults";

/**
 * Layer 24-10: sensible defaults. Proves every seeded row is real (not
 * a fabricated metric) — a real agent, a real spend cap, real
 * capability grants, and a real policy row, all queryable exactly like
 * anything a merchant configured by hand, plus the audit entry
 * recording where they came from.
 */

describe("seedOnboardingDefaults — real DB", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;

    const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length > 0) {
      await db.delete(schema.agentCapabilities).where(inArray(schema.agentCapabilities.agentId, agentIds));
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
    }
    await db.delete(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("creates a real agent with a real spend cap, minimal capabilities, and a real policy row — all queryable, none fabricated", async () => {
    const merchant = await createTestMerchant("__onboarding_defaults_test__");
    merchantId = merchant.id;

    const result = await seedOnboardingDefaults(merchant.id);
    expect(result.agentApiKey).toBeTruthy();

    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, result.agentId));
    expect(agent).toBeDefined();
    expect(agent.merchantId).toBe(merchant.id);
    expect(agent.name).toMatch(/default/i);

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, result.agentId));
    expect(cap.status).toBe("active");
    expect(cap.capPaise).toBeGreaterThan(0);
    expect(cap.perTransactionMaxPaise).toBeGreaterThan(0);
    expect(cap.perTransactionMaxPaise).toBeLessThanOrEqual(cap.capPaise);

    const capabilities = await db.select({ capability: schema.agentCapabilities.capability }).from(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, result.agentId));
    const capSet = new Set(capabilities.map((c) => c.capability));
    expect(capSet.has("purchase:create")).toBe(true);
    expect(capSet.has("products:read")).toBe(true);
    // Never the full set by default — negotiation and reward redemption are a merchant's own explicit grant.
    expect(capSet.has("negotiation:create")).toBe(false);
    expect(capSet.has("rewards:redeem")).toBe(false);

    const [policy] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchant.id));
    expect(policy).toBeDefined();
    expect(policy.returnsAccepted).toBe(true);
    expect(policy.returnWindowDays).toBe(7);

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(audit.some((a) => a.event === "onboarding_defaults_seeded")).toBe(true);
    // Every step that ran also has its own real audit entry — this composes existing, already-audited mutations rather than writing rows a merchant couldn't otherwise trace.
    expect(audit.some((a) => a.event === "agent_created")).toBe(true);
    expect(audit.some((a) => a.event === "spend_cap_set")).toBe(true);
    expect(audit.some((a) => a.event === "agent_capabilities_set")).toBe(true);
    expect(audit.some((a) => a.event === "merchant_policy_updated")).toBe(true);
  }, 20_000);
});
