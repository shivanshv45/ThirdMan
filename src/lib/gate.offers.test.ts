import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { acceptOffer } from "@/lib/discount";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 6-1: a discounted purchase must pass through a merchant-authored
 * bundle the gate re-derives, never a caller-asserted amount — the same
 * product_price_match discipline gate.products.test.ts proves for a
 * single variant. If any test here starts failing, the most important
 * bound in this codebase (the caller cannot name its own price) may have
 * been weakened. See DECISIONS.md, "How a discount is represented."
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__gate_offers_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `gate_offers_test_${Date.now()}_${Math.random()}@test.invalid`,
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
      name: "__gate_offers_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

async function makeCap(agentId: string, opts: Partial<typeof schema.spendCaps.$inferInsert> = {}) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise: 10_000_000,
      spentPaise: 0,
      perTransactionMaxPaise: 10_000_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
      ...opts,
    })
    .returning();
  return cap;
}

async function makeVariant(merchantId: string, opts: Partial<typeof schema.productVariants.$inferInsert> = {}) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__test product__", description: "test", status: "active" })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pricePaise: 85_000,
      costPaise: 40_000,
      stock: 10,
      status: "active",
      ...opts,
    })
    .returning();

  return { product, variant };
}

async function makeBundle(
  merchantId: string,
  items: { variantId: string; quantity: number }[],
  opts: Partial<typeof schema.bundles.$inferInsert> = {},
) {
  const [bundle] = await db
    .insert(schema.bundles)
    .values({
      merchantId,
      name: "__test bundle__",
      bundlePricePaise: 150_000,
      status: "active",
      ...opts,
    })
    .returning();

  await db.insert(schema.bundleItems).values(items.map((i) => ({ bundleId: bundle.id, ...i })));
  return bundle;
}

async function makeOffer(
  merchantId: string,
  bundleId: string,
  opts: Partial<typeof schema.offers.$inferInsert> = {},
) {
  const [offer] = await db
    .insert(schema.offers)
    .values({
      merchantId,
      bundleId,
      status: "offered",
      reasonText: "test offer",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...opts,
    })
    .returning();
  return offer;
}

describe("attemptMoneyAction — offer-bound (discounted) purchases", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  let productIds: string[] = [];
  let bundleIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    const currentProductIds = productIds;
    const currentBundleIds = bundleIds;
    merchantId = undefined;
    agentIds = [];
    productIds = [];
    bundleIds = [];

    if (currentAgentIds.length > 0) {
      await db
        .delete(schema.escalations)
        .where(
          inArray(
            schema.escalations.spendCapId,
            db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds)),
          ),
        );
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, currentMerchantId));
    await db.delete(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    // offers FKs into agents — must go before agents is deleted.
    await db.delete(schema.offers).where(eq(schema.offers.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    if (currentBundleIds.length > 0) {
      await db.delete(schema.bundleItems).where(inArray(schema.bundleItems.bundleId, currentBundleIds));
      await db.delete(schema.bundles).where(inArray(schema.bundles.id, currentBundleIds));
    }
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function setup() {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id);
    return { merchantId, agent };
  }

  it("denies a purchase that asserts a discounted amount with no offer referenced — the price bound still holds", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 60_000, // a "discount" the caller invented, no offerId
      context: "House Blend Espresso",
      variantId: variant.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("catalogue price");
  }, 20_000);

  it("denies redemption of an offer that was never accepted", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);
    const bundle = await makeBundle(merchantId, [{ variantId: variant.id, quantity: 1 }], { bundlePricePaise: 70_000 });
    bundleIds.push(bundle.id);
    const offer = await makeOffer(merchantId, bundle.id, { agentId: agent.id }); // status stays "offered"

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 70_000,
      context: "bundle purchase",
      offerId: offer.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("not accepted");
  }, 20_000);

  it("denies redemption of another merchant's offer by id", async () => {
    const { merchantId, agent } = await setup();
    const otherMerchant = await makeMerchant();
    const { product, variant } = await makeVariant(otherMerchant.id, { pricePaise: 85_000, stock: 5 });

    try {
      const bundle = await makeBundle(otherMerchant.id, [{ variantId: variant.id, quantity: 1 }], { bundlePricePaise: 70_000 });
      const offer = await makeOffer(otherMerchant.id, bundle.id, { agentId: agent.id, status: "accepted" });

      const result = await attemptMoneyAction({
        agentId: agent.id,
        merchantId, // this agent's own merchant, not otherMerchant
        type: "order_create",
        amountPaise: 70_000,
        context: "cross-merchant offer probe",
        offerId: offer.id,
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("no offer");
    } finally {
      await db.delete(schema.offers).where(eq(schema.offers.merchantId, otherMerchant.id));
      await db.delete(schema.bundleItems).where(inArray(schema.bundleItems.variantId, [variant.id]));
      await db.delete(schema.bundles).where(eq(schema.bundles.merchantId, otherMerchant.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
      await db.delete(schema.products).where(eq(schema.products.id, product.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, otherMerchant.id));
    }
  }, 20_000);

  it("denies redemption of an expired offer", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);
    const bundle = await makeBundle(merchantId, [{ variantId: variant.id, quantity: 1 }], { bundlePricePaise: 70_000 });
    bundleIds.push(bundle.id);
    const offer = await makeOffer(merchantId, bundle.id, {
      agentId: agent.id,
      status: "accepted",
      expiresAt: new Date(Date.now() - 60 * 1000), // already expired
    });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 70_000,
      context: "expired bundle purchase",
      offerId: offer.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("expired");
  }, 20_000);

  it("denies redemption of a fabricated offer id", async () => {
    const { merchantId, agent } = await setup();

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 70_000,
      context: "fabricated offer",
      offerId: "00000000-0000-0000-0000-000000000000",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("no offer");
  }, 20_000);

  it("denies when the caller's amountPaise disagrees with the offer's own bundle price", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);
    const bundle = await makeBundle(merchantId, [{ variantId: variant.id, quantity: 1 }], { bundlePricePaise: 70_000 });
    bundleIds.push(bundle.id);
    const offer = await makeOffer(merchantId, bundle.id, { agentId: agent.id, status: "accepted" });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 65_000, // disagrees with the bundle's 70,000
      context: "bundle purchase",
      offerId: offer.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bundle price");
  }, 20_000);

  it("allows a purchase against a validly accepted offer, at the bundle's own price, and decrements every item's stock", async () => {
    const { merchantId, agent } = await setup();
    const { product: p1, variant: v1 } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    const { product: p2, variant: v2 } = await makeVariant(merchantId, { pricePaise: 45_000, stock: 5 });
    productIds.push(p1.id, p2.id);
    const bundle = await makeBundle(
      merchantId,
      [
        { variantId: v1.id, quantity: 1 },
        { variantId: v2.id, quantity: 2 },
      ],
      { bundlePricePaise: 150_000 },
    );
    bundleIds.push(bundle.id);
    const offer = await makeOffer(merchantId, bundle.id, { agentId: agent.id, status: "accepted" });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 150_000,
      context: "bundle purchase",
      offerId: offer.id,
    });

    expect(result.decision).toBe("allow");

    const [updatedV1] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, v1.id));
    const [updatedV2] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, v2.id));
    expect(updatedV1.stock).toBe(4);
    expect(updatedV2.stock).toBe(3);

    const [moneyAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(moneyAction.offerId).toBe(offer.id);
  }, 20_000);

  it("denies when a bundle item doesn't have enough stock", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 1 });
    productIds.push(product.id);
    const bundle = await makeBundle(merchantId, [{ variantId: variant.id, quantity: 3 }], { bundlePricePaise: 200_000 });
    bundleIds.push(bundle.id);
    const offer = await makeOffer(merchantId, bundle.id, { agentId: agent.id, status: "accepted" });

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 200_000,
      context: "bundle purchase, insufficient stock",
      offerId: offer.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("stock");

    const [unchanged] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(unchanged.stock).toBe(1);
  }, 20_000);

  it("acceptOffer is idempotent to a race — only one acceptance can claim an offered offer", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);
    const bundle = await makeBundle(merchantId, [{ variantId: variant.id, quantity: 1 }], { bundlePricePaise: 70_000 });
    bundleIds.push(bundle.id);
    const offer = await makeOffer(merchantId, bundle.id, { agentId: agent.id });

    const results = await Promise.all([
      acceptOffer(merchantId, offer.id, { agentId: agent.id }),
      acceptOffer(merchantId, offer.id, { agentId: agent.id }),
    ]);

    expect(results.filter(Boolean).length).toBe(1);
  }, 20_000);
});
