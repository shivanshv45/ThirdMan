import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { runOfferEngine } from "@/lib/offer-engine";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 6-2: the deterministic filter (eligibility, margin floor) must
 * run BEFORE the model ever sees a candidate, and a run producing no
 * offer must be a first-class recorded outcome, not a silent early
 * return. Tests here assert the candidate SET the filter produces
 * directly, not just the model's eventual pick — testing the filter
 * beats testing the outcome (plans/layer-6-upsell-bundling-rewards.md).
 */

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
    .values({ merchantId, name: "__test bundle__", bundlePricePaise: 150_000, status: "active", ...opts })
    .returning();

  await db.insert(schema.bundleItems).values(items.map((i) => ({ bundleId: bundle.id, ...i })));
  return bundle;
}

describe("runOfferEngine", () => {
  let merchantId: string | undefined;
  let productIds: string[] = [];
  let bundleIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentProductIds = productIds;
    const currentBundleIds = bundleIds;
    merchantId = undefined;
    productIds = [];
    bundleIds = [];

    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, currentMerchantId));
    await db.delete(schema.offers).where(eq(schema.offers.merchantId, currentMerchantId));
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

  it("no offer, recorded, when no bundle is eligible at all", async () => {
    const merchant = await createTestMerchant("__offer_engine_test__");
    merchantId = merchant.id;
    const { product, variant } = await makeVariant(merchantId);
    productIds.push(product.id);

    const result = await runOfferEngine(merchantId, variant.id, { sessionToken: "sess-1" });

    expect(result.offer).toBeNull();
    expect(result.noOfferReason).toContain("No eligible bundle");

    const [decision] = await db.select().from(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));
    expect(decision.eligibleCandidateCount).toBe(0);
    expect(decision.offeredOfferId).toBeNull();
  });

  it("the margin floor removes a below-cost bundle before the model ever sees it — no offer, recorded with the exact count", async () => {
    const merchant = await createTestMerchant("__offer_engine_test__");
    merchantId = merchant.id;
    const { product: p1, variant: cartVariant } = await makeVariant(merchantId, { pricePaise: 85_000, costPaise: 40_000 });
    const { product: p2, variant: upsellVariant } = await makeVariant(merchantId, { pricePaise: 50_000, costPaise: 45_000 });
    productIds.push(p1.id, p2.id);

    // Bundle priced below its own item's cost — must be filtered out
    // before any model call, per the margin-floor contract.
    const belowFloorBundle = await makeBundle(merchantId, [{ variantId: upsellVariant.id, quantity: 1 }], { bundlePricePaise: 40_000 });
    bundleIds.push(belowFloorBundle.id);

    const result = await runOfferEngine(merchantId, cartVariant.id, { sessionToken: "sess-2" });

    expect(result.offer).toBeNull();
    expect(result.noOfferReason).toContain("margin floor");

    const [decision] = await db.select().from(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));
    expect(decision.eligibleCandidateCount).toBe(1);
    expect(decision.belowMarginFloorCount).toBe(1);
    expect(decision.offeredOfferId).toBeNull();
  });

  it("a bundle whose only item is the cart's own variant is never eligible — offering the thing already being bought isn't an upsell", async () => {
    const merchant = await createTestMerchant("__offer_engine_test__");
    merchantId = merchant.id;
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 85_000, costPaise: 40_000 });
    productIds.push(product.id);

    const selfBundle = await makeBundle(merchantId, [{ variantId: variant.id, quantity: 1 }], { bundlePricePaise: 80_000 });
    bundleIds.push(selfBundle.id);

    const result = await runOfferEngine(merchantId, variant.id, { sessionToken: "sess-3" });

    expect(result.offer).toBeNull();
    const [decision] = await db.select().from(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));
    expect(decision.eligibleCandidateCount).toBe(0);
  });

  it("a profitable, eligible bundle survives the filter and reaches a real offer via a live model call", async () => {
    const merchant = await createTestMerchant("__offer_engine_test__");
    merchantId = merchant.id;
    const { product: p1, variant: cartVariant } = await makeVariant(merchantId, {
      pricePaise: 85_000,
      costPaise: 40_000,
      sku: "COFFEE-250G",
    });
    const { product: p2, variant: upsellVariant } = await makeVariant(merchantId, {
      pricePaise: 30_000,
      costPaise: 10_000,
      sku: "COFFEE-MUG",
    });
    productIds.push(p1.id, p2.id);

    const goodBundle = await makeBundle(merchantId, [{ variantId: upsellVariant.id, quantity: 1 }], {
      name: "Coffee + Mug Bundle",
      bundlePricePaise: 100_000, // well above the 10,000 cost floor
    });
    bundleIds.push(goodBundle.id);

    const result = await runOfferEngine(merchantId, cartVariant.id, { sessionToken: "sess-4" });

    // The model may reasonably decline to offer, but if it offers, it
    // must be this exact bundle at this exact merchant-set price — never
    // a number the model invented.
    if (result.offer) {
      expect(result.offer.bundleId).toBe(goodBundle.id);
      expect(result.offer.amountPaise).toBe(100_000);
      expect(result.offer.reasonText.toLowerCase()).not.toContain("margin");
      expect(result.offer.reasonText.toLowerCase()).not.toContain("cost");

      const [offerRow] = await db.select().from(schema.offers).where(eq(schema.offers.id, result.offer.offerId));
      expect(offerRow.status).toBe("offered");
    } else {
      expect(result.noOfferReason).toBeTruthy();
    }

    const [decision] = await db.select().from(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));
    expect(decision.eligibleCandidateCount).toBe(1);
    expect(decision.belowMarginFloorCount).toBe(0);
  }, 20_000);
});
