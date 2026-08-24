import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

async function main() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: "__schema_check_merchant__",
      email: `schema_check_${Date.now()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  console.log("Inserted merchant:", merchant.id);

  const [readBack] = await db
    .select()
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchant.id));
  console.log("Read back:", readBack);

  if (readBack?.name !== "__schema_check_merchant__") {
    throw new Error("Round-trip mismatch");
  }

  // Exercise every table with a linked row, proving the FK chain works end to end.
  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId: merchant.id,
      name: "Test Product",
      description: "Schema check only",
      pricePaise: 10000,
      costPaise: 6000,
      stock: 5,
    })
    .returning();

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: "Test Agent",
      apiKeyHash: `check_${merchant.id}`,
    })
    .returning();

  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: agent.id,
      capPaise: 100000,
      perTransactionMaxPaise: 50000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .returning();

  const [action] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId: merchant.id,
      agentId: agent.id,
      type: "order_create",
      amountPaise: product.pricePaise,
      status: "allowed",
    })
    .returning();

  const [entry] = await db
    .insert(schema.auditLog)
    .values({
      merchantId: merchant.id,
      moneyActionId: action.id,
      actor: "agent",
      event: "schema_check",
      decision: "allow",
      reason: "Schema round-trip verification — not a real decision.",
      boundApplied: `spend_cap:${cap.id} remaining ₹1000 of ₹1000`,
    })
    .returning();

  console.log("Full chain inserted OK:", {
    product: product.id,
    agent: agent.id,
    cap: cap.id,
    action: action.id,
    auditEntry: entry.id,
  });

  // Clean up — this script only proves the schema round-trips, it
  // shouldn't leave synthetic rows behind for L0-7's seed data to trip over.
  await db.delete(schema.auditLog).where(eq(schema.auditLog.id, entry.id));
  await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, action.id));
  await db.delete(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
  await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
  await db.delete(schema.products).where(eq(schema.products.id, product.id));
  await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));

  console.log("Cleaned up. Schema check passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Schema check FAILED:", err);
  process.exit(1);
});
