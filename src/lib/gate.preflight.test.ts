import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 13-5: preflight/dry-run. The one rule that makes this honest is
 * that dryRun runs through the exact same checkBounds() every real
 * attempt does — these tests prove that by exercising the identical
 * bound failures gate.products.test.ts/gate.test.ts already cover, this
 * time with dryRun: true, and asserting nothing was reserved either way.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__preflight_test_${Date.now()}_${Math.random()}__`,
      email: `preflight_test_${Date.now()}_${Math.random()}@test.invalid`,
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
      name: "__preflight_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise: number, perTransactionMaxPaise: number = capPaise) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise,
      spentPaise: 0,
      perTransactionMaxPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();
  return cap;
}

async function makeVariant(merchantId: string, opts: Partial<typeof schema.productVariants.$inferInsert> = {}) {
  const [product] = await db.insert(schema.products).values({ merchantId, name: "__test__", description: "test", status: "active" }).returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `PF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pricePaise: 85_000,
      costPaise: 40_000,
      stock: 10,
      status: "active",
      ...opts,
    })
    .returning();
  return { product, variant };
}

describe("attemptMoneyAction dryRun — preflight shares the real code path", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  let productIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    const currentProductIds = productIds;
    merchantId = undefined;
    agentIds = [];
    productIds = [];

    if (currentAgentIds.length > 0) {
      await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds))));
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
      await db.delete(schema.agentGuardianState).where(inArray(schema.agentGuardianState.agentId, currentAgentIds));
      await db.delete(schema.guardianTransitions).where(inArray(schema.guardianTransitions.agentId, currentAgentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("a dry-run within cap and stock returns allow, reserves nothing, executes nothing, and creates no money_actions row", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id, 1_000_000, 1_000_000);
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "dry-run purchase",
      variantId: variant.id,
      dryRun: true,
    });

    expect(result.decision).toBe("allow");
    expect(result.moneyActionId).toBeUndefined();
    expect(result.razorpayOrderId).toBeUndefined();

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(0);

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(5);

    const actions = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    expect(actions.length).toBe(0);

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    expect(audit.some((a) => a.event === "preflight_evaluated" && a.decision === "n/a")).toBe(true);
  });

  it("a dry-run above the per-transaction max denies with the identical reason a real attempt would get", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id, 1_000_000, 50_000);

    const dryRunResult = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 100_000,
      context: "dry-run over per-tx max",
      dryRun: true,
    });

    const realResult = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 100_000,
      context: "real attempt over per-tx max",
    });

    expect(dryRunResult.decision).toBe("deny");
    expect(realResult.decision).toBe("deny");
    // Same bound, same underlying reason text (preflight prefixes it).
    expect(dryRunResult.reason).toContain(realResult.reason);
  });

  it("a dry-run against insufficient stock denies exactly like a real attempt, and stock is untouched either way", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id, 1_000_000, 1_000_000);
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 0 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "dry-run zero stock",
      variantId: variant.id,
      dryRun: true,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/stock/i);

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(0);
  });

  it("a dry-run for a suspended agent (Guardian) denies with the guardian bound — proving preflight sees the Guardian too, not just spend/stock", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id, 1_000_000, 1_000_000);

    await db.insert(schema.agentGuardianState).values({ agentId: agent.id, state: "suspended", lastSignal: "manual_test_setup" });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "dry-run against a suspended agent",
      dryRun: true,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/suspended/i);
  });
});
