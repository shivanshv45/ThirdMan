import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createOrder } from "@/lib/razorpay";
import { logAuditEntry, getRecentAuditEntries } from "@/lib/audit";

/**
 * L0-8 — proves every Layer 0 piece works together as one chain:
 * load config -> create a real Razorpay test order for a seeded product
 * -> record a money_actions row -> write a linked audit entry with a
 * real reason -> read back the audit trail.
 *
 * This is the smallest end-to-end money action with a complete record.
 * If this passes, Layer 1 has everything it needs.
 */

async function main() {
  const [merchant] = await db.select().from(schema.merchants).limit(1);
  if (!merchant) {
    throw new Error("No merchant found — run `npm run script scripts/seed.ts` first.");
  }

  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.merchantId, merchant.id))
    .limit(1);
  if (!product) {
    throw new Error("No product found — run `npm run script scripts/seed.ts` first.");
  }

  console.log(`Using merchant "${merchant.name}", product "${product.name}" (₹${product.pricePaise / 100}).`);

  const order = await createOrder({
    amountPaise: product.pricePaise,
    receipt: `integration_proof_${Date.now()}`,
    notes: { productId: product.id, purpose: "L0-8 integration proof" },
  });
  console.log("Created Razorpay test order:", order.id);

  const [moneyAction] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: order.amountPaise,
      status: "executed",
      razorpayEntityId: order.id,
    })
    .returning();
  console.log("Recorded money_actions row:", moneyAction.id);

  await logAuditEntry({
    merchantId: merchant.id,
    actor: "system",
    event: "order_created",
    decision: "allow",
    reason: `Created a ₹${(order.amountPaise / 100).toFixed(2)} order for "${product.name}" as part of the Layer 0 integration proof — no spend cap applies yet, this predates Layer 1.`,
    boundApplied: "none — Layer 1 gate not yet built",
    moneyActionId: moneyAction.id,
    metadata: { razorpayOrderId: order.id, productId: product.id },
  });
  console.log("Wrote linked audit entry.");

  const trail = await getRecentAuditEntries(merchant.id, 5);
  const entry = trail.find((e) => e.moneyAction?.id === moneyAction.id);

  if (!entry) {
    throw new Error("Audit entry not found when reading back the trail — integration is broken.");
  }

  console.log("\nAudit trail readback:");
  console.log(`  [${entry.decision.toUpperCase()}] ${entry.reason}`);
  console.log(`  Bound applied: ${entry.boundApplied}`);
  console.log(`  Money action: ${entry.moneyAction?.type} — ₹${(entry.moneyAction!.amountPaise / 100).toFixed(2)} — ${entry.moneyAction?.status}`);
  console.log(`  Razorpay order: ${entry.moneyAction?.razorpayEntityId}`);

  console.log("\nL0-8 integration proof PASSED. Verify order", order.id, "appears in the Razorpay Test Mode dashboard.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Integration proof FAILED:", err);
    process.exit(1);
  });
