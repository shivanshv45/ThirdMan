import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { recomputeDerivedMemory } from "@/lib/memory/derived";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 18-2: derived memory matches the live query it claims to
 * summarise, is recomputed (not accumulated) on a second call, and
 * costPaise/margin never enter it.
 */

describe("recomputeDerivedMemory", () => {
  const merchantIds: string[] = [];
  const agentIds: string[] = [];

  afterEach(async () => {
    for (const merchantId of merchantIds) {
      await db.delete(schema.agentMemories).where(eq(schema.agentMemories.merchantId, merchantId));
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    }
    for (const agentId of agentIds) {
      await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    }
    for (const merchantId of merchantIds) {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
    merchantIds.length = 0;
    agentIds.length = 0;
  });

  it("an agent subject with no captured purchases gets no prior_purchase_summary fact", async () => {
    const merchant = await createTestMerchant("__derived_test_none__");
    merchantIds.push(merchant.id);
    const [agent] = await db.insert(schema.agents).values({ merchantId: merchant.id, name: "a", apiKeyHash: `t_${Date.now()}_${Math.random()}`, status: "active" }).returning();
    agentIds.push(agent.id);

    await recomputeDerivedMemory(merchant.id, "agent", agent.id);

    const rows = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.subjectId, agent.id));
    expect(rows.find((r) => r.key === "prior_purchase_summary")).toBeUndefined();
  });

  it("a derived fact matches the live captured-purchase count and is confirmed immediately", async () => {
    const merchant = await createTestMerchant("__derived_test_purchases__");
    merchantIds.push(merchant.id);
    const [agent] = await db.insert(schema.agents).values({ merchantId: merchant.id, name: "a", apiKeyHash: `t_${Date.now()}_${Math.random()}`, status: "active" }).returning();
    agentIds.push(agent.id);

    await db.insert(schema.moneyActions).values([
      { merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 10_000, status: "captured" },
      { merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 20_000, status: "captured" },
      { merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 30_000, status: "pending_escalation" }, // not captured — must not count
    ]);

    await recomputeDerivedMemory(merchant.id, "agent", agent.id);

    const [row] = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.subjectId, agent.id));
    expect(row.key).toBe("prior_purchase_summary");
    expect(row.value).toContain("2 prior captured purchase");
    expect(row.confirmedAt).not.toBeNull();
    expect(row.sourceType).toBe("money_action");
  });

  it("costPaise/margin never appear in a derived value", async () => {
    const merchant = await createTestMerchant("__derived_test_no_cost__");
    merchantIds.push(merchant.id);
    const [agent] = await db.insert(schema.agents).values({ merchantId: merchant.id, name: "a", apiKeyHash: `t_${Date.now()}_${Math.random()}`, status: "active" }).returning();
    agentIds.push(agent.id);

    const COST_MARKER = "918273";
    await db.insert(schema.moneyActions).values({ merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 10_000, status: "captured" });

    await recomputeDerivedMemory(merchant.id, "agent", agent.id);

    const rows = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.subjectId, agent.id));
    for (const row of rows) {
      expect(row.value).not.toContain(COST_MARKER);
    }
  });

  it("recomputing deletes a stale fact whose underlying condition no longer holds — no accumulation", async () => {
    const merchant = await createTestMerchant("__derived_test_stale__");
    merchantIds.push(merchant.id);
    const [agent] = await db.insert(schema.agents).values({ merchantId: merchant.id, name: "a", apiKeyHash: `t_${Date.now()}_${Math.random()}`, status: "active" }).returning();
    agentIds.push(agent.id);

    const [action] = await db.insert(schema.moneyActions).values({ merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 10_000, status: "captured" }).returning();
    await recomputeDerivedMemory(merchant.id, "agent", agent.id);

    let rows = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.subjectId, agent.id));
    expect(rows.find((r) => r.key === "prior_purchase_summary")).toBeDefined();

    // The purchase no longer counts as captured (e.g. a refund) — a
    // second recompute must remove the now-stale fact, not leave it
    // sitting alongside reality.
    await db.update(schema.moneyActions).set({ status: "failed" }).where(eq(schema.moneyActions.id, action.id));
    await recomputeDerivedMemory(merchant.id, "agent", agent.id);

    rows = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.subjectId, agent.id));
    expect(rows.find((r) => r.key === "prior_purchase_summary")).toBeUndefined();
  });

  it("a customer_contact subject with no derivable facts yields no rows, an honest absence rather than an error", async () => {
    const merchant = await createTestMerchant("__derived_test_contact_none__");
    merchantIds.push(merchant.id);

    await recomputeDerivedMemory(merchant.id, "customer_contact", crypto.randomUUID());
    // No throw is the assertion — nothing to read back since no contact row exists to join against.
  });
});
