import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 25-3's central claim, stated in
 * plans/layer-25-control-surfaces.md: "the Trust Score is shown to a
 * merchant. It is never read by gate.ts." This is the third instance of
 * this exact proof pattern in the codebase (memory in L18, this one for
 * L25-3) — a static import check plus a behavioural equivalence test:
 * two identical dry-run gate decisions, one for an agent with a strong
 * trust score (long history, no incidents) and one for an agent with a
 * deliberately weak one (fresh, denied, suspended, bad-faith
 * negotiations), must be byte-identical.
 */

describe("gate.ts never imports trust-score", () => {
  it("has no import of src/lib/trust-score anywhere in its source", () => {
    const source = readFileSync(new URL("./gate.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']@\/lib\/trust-score/);
  });
});

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__trust_test_${Date.now()}_${Math.random()}__`,
      email: `trust_test_${Date.now()}_${Math.random()}@test.invalid`,
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
    .values({ merchantId, name: "__trust_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
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
    .values({ productId: product.id, merchantId, sku: `TS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, pricePaise: 85_000, costPaise: 40_000, stock: 10, status: "active", ...opts })
    .returning();
  return { product, variant };
}

describe("trust score never moves the gate", () => {
  const merchantIds: string[] = [];
  const agentIds: string[] = [];
  const productIds: string[] = [];

  afterEach(async () => {
    const currentMerchantIds = [...merchantIds];
    const currentAgentIds = [...agentIds];
    const currentProductIds = [...productIds];
    merchantIds.length = 0;
    agentIds.length = 0;
    productIds.length = 0;

    if (currentAgentIds.length > 0) {
      await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds))));
      await db.delete(schema.negotiations).where(inArray(schema.negotiations.agentId, currentAgentIds));
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
      await db.delete(schema.agentGuardianState).where(inArray(schema.agentGuardianState.agentId, currentAgentIds));
      await db.delete(schema.guardianTransitions).where(inArray(schema.guardianTransitions.agentId, currentAgentIds));
    }
    for (const merchantId of currentMerchantIds) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    }
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    for (const merchantId of currentMerchantIds) {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("identical purchase, same amount and cap — allow decision is byte-identical for a strong-trust agent and a weak-trust agent", async () => {
    const merchantStrong = await makeMerchant();
    merchantIds.push(merchantStrong.id);
    const agentStrong = await makeAgent(merchantStrong.id);
    agentIds.push(agentStrong.id);
    await makeCap(agentStrong.id, 1_000_000, 1_000_000);
    const { product: productStrong, variant: variantStrong } = await makeVariant(merchantStrong.id, { pricePaise: 85_000, stock: 5 });
    productIds.push(productStrong.id);

    const merchantWeak = await makeMerchant();
    merchantIds.push(merchantWeak.id);
    const agentWeak = await makeAgent(merchantWeak.id);
    agentIds.push(agentWeak.id);
    await makeCap(agentWeak.id, 1_000_000, 1_000_000);
    const { product: productWeak, variant: variantWeak } = await makeVariant(merchantWeak.id, { pricePaise: 85_000, stock: 5 });
    productIds.push(productWeak.id);

    // A deliberately WEAK trust signal for the "weak" agent — a real
    // Guardian suspension transition and a failed negotiation — the
    // exact shape of evidence a high trust score would want to punish,
    // if the trust score could reach the gate at all.
    await db.insert(schema.guardianTransitions).values({
      agentId: agentWeak.id,
      fromState: "throttled",
      toState: "suspended",
      triggerSignal: "denied_ratio",
      observedValue: "90%",
      baselineValue: "60%",
    });
    await db.insert(schema.negotiations).values({
      merchantId: merchantWeak.id,
      agentId: agentWeak.id,
      variantId: variantWeak.id,
      quantity: 1,
      catalogueUnitPricePaise: 85_000,
      floorUnitPricePaise: 80_000,
      status: "refused_turns_exhausted",
      buyerTurnCount: 5,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      resolvedAt: new Date(),
    });

    const strongResult = await attemptMoneyAction({
      agentId: agentStrong.id,
      merchantId: merchantStrong.id,
      type: "order_create",
      amountPaise: 85_000,
      context: "trust-equivalence purchase",
      variantId: variantStrong.id,
      dryRun: true,
    });

    const weakResult = await attemptMoneyAction({
      agentId: agentWeak.id,
      merchantId: merchantWeak.id,
      type: "order_create",
      amountPaise: 85_000,
      context: "trust-equivalence purchase",
      variantId: variantWeak.id,
      dryRun: true,
    });

    expect(weakResult.decision).toBe(strongResult.decision);
    expect(weakResult.decision).toBe("allow");
    expect(weakResult.reason).toBe(strongResult.reason);
  }, 20_000);

  it("identical purchase over the per-transaction cap — deny decision and reason are byte-identical regardless of trust score", async () => {
    const merchantStrong = await makeMerchant();
    merchantIds.push(merchantStrong.id);
    const agentStrong = await makeAgent(merchantStrong.id);
    agentIds.push(agentStrong.id);
    await makeCap(agentStrong.id, 1_000_000, 50_000);
    const { product: productStrong, variant: variantStrong } = await makeVariant(merchantStrong.id, { pricePaise: 85_000, stock: 5 });
    productIds.push(productStrong.id);

    const merchantWeak = await makeMerchant();
    merchantIds.push(merchantWeak.id);
    const agentWeak = await makeAgent(merchantWeak.id);
    agentIds.push(agentWeak.id);
    await makeCap(agentWeak.id, 1_000_000, 50_000);
    const { product: productWeak, variant: variantWeak } = await makeVariant(merchantWeak.id, { pricePaise: 85_000, stock: 5 });
    productIds.push(productWeak.id);

    const strongResult = await attemptMoneyAction({
      agentId: agentStrong.id,
      merchantId: merchantStrong.id,
      type: "order_create",
      amountPaise: 85_000,
      context: "trust-equivalence over-cap purchase",
      variantId: variantStrong.id,
      dryRun: true,
    });

    const weakResult = await attemptMoneyAction({
      agentId: agentWeak.id,
      merchantId: merchantWeak.id,
      type: "order_create",
      amountPaise: 85_000,
      context: "trust-equivalence over-cap purchase",
      variantId: variantWeak.id,
      dryRun: true,
    });

    expect(weakResult.decision).toBe(strongResult.decision);
    expect(weakResult.decision).toBe("deny");
    expect(weakResult.reason).toBe(strongResult.reason);
  }, 20_000);
});
