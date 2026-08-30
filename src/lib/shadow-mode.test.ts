import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { enableShadowMode, disableShadowMode, isShadowModeEnabled, getShadowModeState } from "@/lib/shadow-mode";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 24-8: Shadow Mode. Tests the plan's own required properties
 * against the real DB and the real gate — never asserted by inspecting
 * a UI state:
 * - a real purchase that would otherwise be ALLOWED and executed is
 *   instead evaluated only, with nothing reserved, executed, or written
 *   as a money_actions row, while Shadow Mode is on
 * - this is enforced by the gate itself: a caller who never heard of
 *   Shadow Mode and never passed dryRun still gets the exact same
 *   non-execution — it cannot be bypassed by a caller's own request shape
 * - turning Shadow Mode off restores real execution for the identical
 *   request
 * - a request that would have been DENIED anyway is still reported as a
 *   simulated denial, not silently upgraded to "would allow"
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__shadow_test_${Date.now()}_${Math.random()}__`,
      email: `shadow_test_${Date.now()}_${Math.random()}@test.invalid`,
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
    .values({ merchantId, name: "__shadow_test_agent__", apiKeyHash: `shadow_test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise: number, perTransactionMaxPaise: number = capPaise) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({ agentId, capPaise, spentPaise: 0, perTransactionMaxPaise, windowStart: now, windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000), status: "active" })
    .returning();
  return cap;
}

async function makeVariant(merchantId: string, opts: Partial<typeof schema.productVariants.$inferInsert> = {}) {
  const [product] = await db.insert(schema.products).values({ merchantId, name: "__test__", description: "test", status: "active" }).returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product.id, merchantId, sku: `SM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, pricePaise: 85_000, costPaise: 40_000, stock: 10, status: "active", ...opts })
    .returning();
  return { product, variant };
}

describe("Shadow Mode — real DB, real gate integration", () => {
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
    }
    await db.delete(schema.merchantShadowMode).where(eq(schema.merchantShadowMode.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("a request that would be allowed and executed instead evaluates only — no reservation, no execution, no money_actions row, while Shadow Mode is on", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id, 1_000_000, 1_000_000);
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);

    await enableShadowMode(merchantId);
    expect(await isShadowModeEnabled(merchantId)).toBe(true);

    // The caller here is an ordinary purchase request with no dryRun of
    // its own — Shadow Mode must catch this at the gate, not rely on
    // the caller to know it's on.
    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "would-be real purchase under shadow mode",
      variantId: variant.id,
    });

    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/shadow mode/i);
    expect(result.moneyActionId).toBeUndefined();

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(0);

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(5);

    const actions = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    expect(actions.length).toBe(0);

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    expect(audit.some((a) => a.event === "shadow_mode_evaluated" && a.decision === "n/a")).toBe(true);
  }, 20_000);

  it("a request that would genuinely be denied is still reported as a simulated denial, never upgraded to allow", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id, 1_000_000, 50_000);

    await enableShadowMode(merchantId);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 100_000,
      context: "over per-transaction max, under shadow mode",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/shadow mode/i);
  }, 20_000);

  it("turning Shadow Mode off restores real execution for the identical request shape", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id, 1_000_000, 1_000_000);
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);

    await enableShadowMode(merchantId);
    const shadowResult = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "shadow attempt",
      variantId: variant.id,
      idempotencyKey: `shadow-then-real-${Date.now()}`,
    });
    expect(shadowResult.moneyActionId).toBeUndefined();

    await disableShadowMode(merchantId);
    expect(await isShadowModeEnabled(merchantId)).toBe(false);
    expect(await getShadowModeState(merchantId)).toBeNull();

    const realResult = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "real attempt after shadow mode off",
      variantId: variant.id,
      idempotencyKey: `shadow-then-real-${Date.now()}-2`,
    });
    expect(realResult.decision).toBe("allow");
    expect(realResult.moneyActionId).toBeDefined();

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(4);
  }, 30_000);

  it("enabling twice is a no-op, not a duplicate row or a second audit entry", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;

    await enableShadowMode(merchantId);
    await enableShadowMode(merchantId);

    const rows = await db.select().from(schema.merchantShadowMode).where(eq(schema.merchantShadowMode.merchantId, merchantId));
    expect(rows.length).toBe(1);

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    expect(audit.filter((a) => a.event === "shadow_mode_enabled").length).toBe(1);
  });

  it("a caller-requested preflight (Layer 13-5) is labelled distinctly from a Shadow Mode evaluation", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id, 1_000_000, 1_000_000);

    // No shadow mode enabled — this is an ordinary preflight request.
    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000,
      context: "ordinary preflight, no shadow mode",
      dryRun: true,
    });
    expect(result.reason).toMatch(/preflight/i);
    expect(result.reason).not.toMatch(/shadow mode/i);

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    expect(audit.some((a) => a.event === "preflight_evaluated")).toBe(true);
    expect(audit.some((a) => a.event === "shadow_mode_evaluated")).toBe(false);
  }, 20_000);
});
