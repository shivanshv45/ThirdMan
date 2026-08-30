import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { createProposedAgents } from "./setup-conversation-confirm";
import { draftSetupProposal } from "./setup-conversation";

/**
 * Layer 24-7: real-DB coverage of createProposedAgents (the only
 * writer) plus a real Groq call through draftSetupProposal proving the
 * model never reaches a row on its own — matching the plan's L24-12
 * headline shape from Layer 22's returns demo: "the model said yes, and
 * nothing moved" until the merchant's own confirm call runs.
 */

describe("createProposedAgents — real DB", () => {
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
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("creates a real agent, spend cap, and capability grants from a confirmed proposal", async () => {
    const merchant = await createTestMerchant("__setup_conv_confirm_test__");
    merchantId = merchant.id;

    const result = await createProposedAgents(merchant.id, {
      agents: [
        {
          name: "Recovery bot",
          purpose: "Chase failed payments and retry them.",
          suggestedCapRupees: 3000,
          capReason: "Conservative first cap for a recovery agent.",
          suggestedPerTransactionMaxRupees: 500,
          capabilities: ["products:read", "purchase:create"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created.length).toBe(1);
    expect(result.created[0].apiKey).toBeTruthy();

    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, result.created[0].agentId));
    expect(agent.name).toBe("Recovery bot");

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    expect(cap.capPaise).toBe(300_000);
    expect(cap.perTransactionMaxPaise).toBe(50_000);

    const caps = await db.select({ capability: schema.agentCapabilities.capability }).from(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agent.id));
    expect(new Set(caps.map((c) => c.capability))).toEqual(new Set(["products:read", "purchase:create"]));

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(audit.some((a) => a.event === "setup_conversation_confirmed")).toBe(true);
  });

  it("creates the whole batch or none — a malformed second agent in the same proposal rejects the entire confirm, no partial fleet", async () => {
    const merchant = await createTestMerchant("__setup_conv_confirm_test_2__");
    merchantId = merchant.id;

    const result = await createProposedAgents(merchant.id, {
      agents: [
        { name: "Good agent", purpose: "x", suggestedCapRupees: 1000, capReason: "x", suggestedPerTransactionMaxRupees: 100, capabilities: ["products:read"] },
        { name: "Bad agent", purpose: "x", suggestedCapRupees: -5, capReason: "x", suggestedPerTransactionMaxRupees: 100, capabilities: ["products:read"] },
      ],
    });

    expect(result.ok).toBe(false);

    const agents = await db.select().from(schema.agents).where(eq(schema.agents.merchantId, merchant.id));
    expect(agents.length).toBe(0);
  });

  it("rejects an unrecognized capability rather than silently dropping it into an unexpected grant", async () => {
    const merchant = await createTestMerchant("__setup_conv_confirm_test_3__");
    merchantId = merchant.id;

    const result = await createProposedAgents(merchant.id, {
      agents: [{ name: "x", purpose: "x", suggestedCapRupees: 1000, capReason: "x", suggestedPerTransactionMaxRupees: 100, capabilities: ["refunds:issue"] }],
    });

    expect(result.ok).toBe(false);
  });
});

describe("setup conversation — the model cannot write a row on its own", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("a real model call drafting a generous fleet leaves no agents, no spend_caps rows — nothing moves until confirm", async () => {
    const merchant = await createTestMerchant("__setup_conv_model_test__");
    merchantId = merchant.id;

    const draft = await draftSetupProposal(merchant.id, "I need something to chase failed payments, and two that can talk to customers and negotiate discounts up to 20%");

    // Whatever the model proposed, no row exists yet — draftSetupProposal
    // has no capability to write one (see the isolation test).
    const agents = await db.select().from(schema.agents).where(eq(schema.agents.merchantId, merchant.id));
    expect(agents.length).toBe(0);

    if (draft.ok) {
      expect(draft.proposal.agents.length).toBeGreaterThan(0);
      expect(draft.proposal.agents.length).toBeLessThanOrEqual(5);
    }
  }, 30_000);
});
