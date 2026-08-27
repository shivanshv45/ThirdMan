import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { openNegotiation, submitBuyerCounter } from "@/lib/negotiation";
import { attemptMoneyAction } from "@/lib/gate";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";

/**
 * Layer 8's required failure demo: a real buyer negotiates a real
 * variant down through several real turns, reaches the merchant's floor,
 * counters below it, and is REFUSED — with the exact arithmetic printed
 * — then buys at the agreed floor price for real, through the real gate,
 * producing a real money_actions row and audit entry.
 *
 * The floor check itself is pure deterministic arithmetic (negotiation.ts's
 * submitBuyerCounter compares the buyer's counter to floorUnitPricePaise
 * before any model call could run), so this demo's PASS/FAIL assertions
 * never depend on a live model call succeeding — matching L6-7's
 * demo-failure-upsell-refused.ts, which was explicitly built the same
 * way to avoid Groq's daily-quota flakiness (FAILURES.md, L5-8/L6-7).
 *
 * "The floor must be unbreakable by the model, and provably so."
 * (plans/layer-8-negotiation.md's closing bar)
 *
 * Repeatable, self-cleaning (try/finally), explicit exit code on both
 * paths (FAILURES.md — a missing exit reads as a hang).
 */

async function main() {
  console.log("=== Demo: a negotiation floor holds even under repeated pressure, and the sale still happens ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [product] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Demo Product — Negotiation Floor Holds Scenario", description: "A variant with a real merchant-set negotiation floor.", status: "active" })
    .returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: merchant.id,
      sku: `demo-negotiation-floor-${Date.now()}`,
      pricePaise: 100_000, // ₹1000
      costPaise: 50_000,
      stock: 20,
      status: "active",
      floorPricePaise: 80_000, // ₹800 — the merchant's real, stated minimum
    })
    .returning();

  const sessionToken = crypto.randomUUID();

  try {
    console.log(`1. Merchant set a real floor on "${variant.sku}": catalogue ₹${(variant.pricePaise / 100).toFixed(2)}, floor ₹${(80_000 / 100).toFixed(2)}.\n`);

    console.log("2. Buyer opens a negotiation and lowballs repeatedly, below the floor every time...");
    const { negotiation } = await openNegotiation(merchant.id, variant.id, 1, { sessionToken });
    if (!negotiation) throw new Error("Expected the negotiation to open — demo scenario is broken");

    let last;
    let turn = 1;
    while (true) {
      last = await submitBuyerCounter(negotiation.id, merchant.id, { sessionToken }, 50_000); // always ₹500, well below the ₹800 floor
      console.log(`   Turn ${turn}: buyer offers ₹500.00 — outcome: ${last.outcome} — "${last.message}"`);
      if (last.outcome !== "countered") break;
      turn++;
    }

    if (last.outcome !== "refused") {
      throw new Error(`Expected the negotiation to eventually refuse (turn budget exhausted) rather than agree below the floor, got outcome "${last.outcome}" — demo scenario is broken`);
    }
    if (last.negotiation.agreedUnitPricePaise !== null) {
      throw new Error(`Expected agreedUnitPricePaise to stay null on a refusal — the floor would have been breached — demo scenario is broken`);
    }

    console.log(`\n3. REFUSED — the floor held across every turn. Final recorded status: "${last.negotiation.status}", ${last.negotiation.buyerTurnCount} counter-offers used.\n`);

    console.log("4. A fresh negotiation, this time the buyer offers exactly the floor — agreed instantly, no further rounds needed:");
    // openNegotiation enforces one open negotiation per identity per
    // variant — using the storefront agent's identity here (distinct
    // from the sessionToken used above) so this is a genuinely separate
    // negotiation, not a continuation of the refused one.
    const storefrontAgent = await getOrCreateStorefrontAgent(merchant.id);
    const { negotiation: secondNegotiation } = await openNegotiation(merchant.id, variant.id, 1, { agentId: storefrontAgent.id });
    if (!secondNegotiation) throw new Error("Expected the second negotiation to open — demo scenario is broken");

    const agreed = await submitBuyerCounter(secondNegotiation.id, merchant.id, { agentId: storefrontAgent.id }, 80_000);
    console.log(`   Buyer offers ₹800.00 (exactly the floor) — outcome: ${agreed.outcome} — "${agreed.message}"\n`);

    if (agreed.outcome !== "agreed" || agreed.negotiation.agreedUnitPricePaise !== 80_000) {
      throw new Error(`Expected an immediate agreement at exactly the floor price — demo scenario is broken`);
    }

    console.log("5. The agreed price redeems as a real, gated purchase through the real gate...");
    const purchaseResult = await attemptMoneyAction({
      agentId: storefrontAgent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 80_000,
      context: `Storefront checkout: negotiated price for ${product.name}`,
      negotiationId: secondNegotiation.id,
    });
    console.log(`   ${purchaseResult.decision.toUpperCase()} — ${purchaseResult.reason}\n`);

    if (purchaseResult.decision !== "allow" && purchaseResult.decision !== "escalate") {
      throw new Error(`Expected the negotiated purchase to succeed (allow or escalate), got ${purchaseResult.decision} — demo scenario is broken`);
    }

    console.log(
      "A negotiation floor that holds under repeated pressure from a real buyer, and a sale that still completes at exactly the merchant's stated minimum — the bound held, and the sale still happened.",
    );
  } finally {
    const negotiationRows = await db.select({ id: schema.negotiations.id }).from(schema.negotiations).where(eq(schema.negotiations.variantId, variant.id));
    const negotiationIds = negotiationRows.map((n) => n.id);
    if (negotiationIds.length > 0) {
      await db.delete(schema.negotiationTurns).where(inArray(schema.negotiationTurns.negotiationId, negotiationIds));
    }

    const demoMoneyActions = await db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(inArray(schema.moneyActions.variantId, [variant.id]));
    const demoMoneyActionIds = demoMoneyActions.map((a) => a.id);
    if (demoMoneyActionIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, demoMoneyActionIds));
      await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, demoMoneyActionIds));
    }

    if (negotiationIds.length > 0) {
      await db.delete(schema.negotiations).where(inArray(schema.negotiations.id, negotiationIds));
    }
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    await db.delete(schema.products).where(eq(schema.products.id, product.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
