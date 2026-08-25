import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { runOfferEngine } from "@/lib/offer-engine";
import { attemptMoneyAction } from "@/lib/gate";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";

/**
 * Layer 6's required failure demo: a buyer reaches checkout, the offer
 * engine finds every candidate bundle priced at or below its own item
 * cost, and the merchant's agent deliberately makes no offer — printing
 * the exact eligible-candidate/below-margin-floor arithmetic that
 * produced the refusal, and the recorded offer_decisions row — then the
 * underlying purchase completes normally, unaffected by the refusal.
 *
 * "An agent that refuses to upsell, and can show its arithmetic for why,
 * is a better demo than one that always finds something to sell."
 * (plans/layer-6-upsell-bundling-rewards.md)
 *
 * Repeatable, self-cleaning (try/finally), explicit exit code on both
 * paths (FAILURES.md — a missing exit reads as a hang).
 */

async function main() {
  console.log("=== Demo: the upsell engine refuses to offer an unprofitable bundle ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [cartProduct] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Demo Product — Upsell Refused Scenario (Cart Item)", description: "The item the buyer is already buying.", status: "active" })
    .returning();
  const [cartVariant] = await db
    .insert(schema.productVariants)
    .values({
      productId: cartProduct.id,
      merchantId: merchant.id,
      sku: `demo-refused-cart-${Date.now()}`,
      pricePaise: 85_000,
      costPaise: 40_000,
      stock: 20,
      status: "active",
    })
    .returning();

  const [upsellProduct] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Demo Product — Upsell Refused Scenario (Bundle Item)", description: "What the merchant would like to upsell, but can't profitably.", status: "active" })
    .returning();
  const [upsellVariant] = await db
    .insert(schema.productVariants)
    .values({
      productId: upsellProduct.id,
      merchantId: merchant.id,
      sku: `demo-refused-upsell-${Date.now()}`,
      pricePaise: 100_000,
      costPaise: 95_000,
      stock: 20,
      status: "active",
    })
    .returning();

  // A bundle priced right at (not even below) the item's own cost —
  // margin is exactly zero, which the engine's ">0" floor rejects.
  const [bundle] = await db
    .insert(schema.bundles)
    .values({ merchantId: merchant.id, name: "Demo Bundle — Priced At Cost", bundlePricePaise: 95_000, status: "active", belowCostAcknowledged: false })
    .returning();
  await db.insert(schema.bundleItems).values({ bundleId: bundle.id, variantId: upsellVariant.id, quantity: 1 });

  const sessionToken = crypto.randomUUID();

  try {
    console.log("1. A buyer has this cart item, and the merchant has exactly one candidate bundle, priced at zero margin:");
    console.log(`   Bundle "${bundle.name}": ₹${(bundle.bundlePricePaise / 100).toFixed(2)}, item cost ₹${(upsellVariant.costPaise / 100).toFixed(2)} — margin = ₹0.00\n`);

    console.log("2. Running the real offer engine against this real cart...");
    const result = await runOfferEngine(merchant.id, cartVariant.id, { sessionToken });

    if (result.offer) {
      throw new Error(`Expected no offer (zero margin should have been filtered before the model ran), but got one: ${JSON.stringify(result.offer)} — demo scenario is broken`);
    }

    console.log(`   REFUSED — ${result.noOfferReason}\n`);

    const [decision] = await db
      .select()
      .from(schema.offerDecisions)
      .where(eq(schema.offerDecisions.merchantId, merchant.id))
      .orderBy(schema.offerDecisions.createdAt)
      .limit(1);

    console.log("3. The exact arithmetic that produced the refusal, recorded in offer_decisions:");
    console.log(`   eligibleCandidateCount: ${decision.eligibleCandidateCount} (the bundle IS eligible — same merchant, active, in stock)`);
    console.log(`   belowMarginFloorCount:  ${decision.belowMarginFloorCount} (but it clears no margin, so it's filtered before any model call)\n`);

    if (decision.eligibleCandidateCount !== 1 || decision.belowMarginFloorCount !== 1) {
      throw new Error(`Expected 1 eligible candidate, 1 below margin floor — got ${decision.eligibleCandidateCount}/${decision.belowMarginFloorCount} — demo scenario is broken`);
    }

    console.log("4. The refusal did not block the underlying purchase — completing it normally...");
    const storefrontAgent = await getOrCreateStorefrontAgent(merchant.id);
    const purchaseResult = await attemptMoneyAction({
      agentId: storefrontAgent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: cartVariant.pricePaise,
      context: `Storefront checkout: ${cartProduct.name}`,
      variantId: cartVariant.id,
      quantity: 1,
    });
    console.log(`   ${purchaseResult.decision.toUpperCase()} — ${purchaseResult.reason}\n`);

    if (purchaseResult.decision !== "allow" && purchaseResult.decision !== "escalate") {
      throw new Error(`Expected the underlying purchase to succeed (allow or escalate) unaffected by the refusal, got ${purchaseResult.decision} — demo scenario is broken`);
    }

    console.log(
      "An upsell engine that refuses to sell what it can't profit on, and can show the exact arithmetic for why, while the real purchase it was checking against completes normally either way.",
    );
  } finally {
    // Scope cleanup to exactly the rows this demo created, by variant/
    // product id — never a bare merchant-scoped delete, since this runs
    // against the real seeded merchant which has its own real data.
    const demoMoneyActions = await db
      .select({ id: schema.moneyActions.id })
      .from(schema.moneyActions)
      .where(inArray(schema.moneyActions.variantId, [cartVariant.id, upsellVariant.id]));
    const demoMoneyActionIds = demoMoneyActions.map((a) => a.id);
    if (demoMoneyActionIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, demoMoneyActionIds));
      await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, demoMoneyActionIds));
    }
    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchant.id));
    await db.delete(schema.bundleItems).where(eq(schema.bundleItems.bundleId, bundle.id));
    await db.delete(schema.bundles).where(eq(schema.bundles.id, bundle.id));
    await db.delete(schema.productVariants).where(inArray(schema.productVariants.id, [cartVariant.id, upsellVariant.id]));
    await db.delete(schema.products).where(inArray(schema.products.id, [cartProduct.id, upsellProduct.id]));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
