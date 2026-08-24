import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";

/**
 * L4-8's required failure demo: an agent tries to buy the last item in
 * stock, twice, at the same instant. Stock is a bound enforced the same
 * atomic way spend_caps.spentPaise is (reserveStock's single conditional
 * UPDATE) — exactly one purchase succeeds, the other is denied cleanly
 * with stock and budget both left untouched. Repeatable, self-cleaning.
 */
async function main() {
  console.log("=== Demo: concurrent purchase of the last item in stock ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId: merchant.id,
      name: "Demo Product — Out of Stock Scenario",
      description: "Last one in stock, for the concurrency demo.",
      pricePaise: 50_000,
      costPaise: 20_000,
      stock: 1,
      status: "active",
    })
    .returning();

  const [agentA] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent A — Out of Stock Scenario", apiKeyHash: `demo_stock_a_${Date.now()}`, status: "active" })
    .returning();
  const [agentB] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent B — Out of Stock Scenario", apiKeyHash: `demo_stock_b_${Date.now()}`, status: "active" })
    .returning();

  const agentIds = [agentA.id, agentB.id];

  try {
    const now = new Date();
    for (const agentId of agentIds) {
      await db.insert(schema.spendCaps).values({
        agentId,
        capPaise: 1_000_000,
        spentPaise: 0,
        perTransactionMaxPaise: 1_000_000,
        windowStart: now,
        windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: "active",
      });
    }

    console.log(`Product "${product.name}" has exactly 1 in stock.`);
    console.log("Two agents attempt to buy it at the same instant.\n");

    const [resultA, resultB] = await Promise.all([
      attemptMoneyAction({
        agentId: agentA.id,
        merchantId: merchant.id,
        type: "order_create",
        amountPaise: product.pricePaise,
        context: product.name,
        productId: product.id,
      }),
      attemptMoneyAction({
        agentId: agentB.id,
        merchantId: merchant.id,
        type: "order_create",
        amountPaise: product.pricePaise,
        context: product.name,
        productId: product.id,
      }),
    ]);

    console.log(`Agent A: ${resultA.decision.toUpperCase()} — ${resultA.reason}`);
    console.log(`Agent B: ${resultB.decision.toUpperCase()} — ${resultB.reason}\n`);

    const decisions = [resultA.decision, resultB.decision].sort();
    if (decisions.join(",") !== "allow,deny") {
      throw new Error(`Expected exactly one allow and one deny, got [${decisions.join(", ")}] — demo scenario is broken`);
    }

    const [updatedProduct] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    console.log(`Stock after: ${updatedProduct.stock} (started at 1, exactly one purchase succeeded).`);
    if (updatedProduct.stock !== 0) {
      throw new Error(`Expected stock 0 after exactly one sale, got ${updatedProduct.stock}`);
    }

    console.log("\nThe denied agent's budget was never touched — stock, like spend caps, is a bound enforced atomically, not by luck.");
  } finally {
    // Cleanup runs even if a step above throws, so a demo run never
    // leaves stray state behind for the next run to trip over.
    const moneyActionIds = (
      await db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(inArray(schema.moneyActions.agentId, agentIds))
    ).map((a) => a.id);
    if (moneyActionIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, moneyActionIds));
      await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, moneyActionIds));
    }
    await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
    await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
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
