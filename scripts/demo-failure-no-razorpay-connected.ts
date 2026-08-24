import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { getRecentAuditEntries } from "@/lib/audit";

/**
 * Layer 2's failure demo: a merchant who hasn't connected a Razorpay
 * account yet tries to let an agent transact. The gate denies it
 * deterministically before reserving any budget, explains exactly what
 * is missing, and nothing crashes. Repeatable — run any number of times.
 */
async function main() {
  console.log("=== Demo: merchant has not connected Razorpay ===\n");

  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: "Demo Merchant — Unconnected Scenario",
      email: `demo_unconnected_${Date.now()}@test.invalid`,
      passwordHash: "demo:not-a-real-hash",
      // razorpayKeyIdEncrypted/SecretEncrypted deliberately left unset.
    })
    .returning();

  try {
    const [agent] = await db
      .insert(schema.agents)
      .values({
        merchantId: merchant.id,
        name: "Demo Agent — Unconnected Scenario",
        apiKeyHash: `demo_unconnected_${Date.now()}`,
        status: "active",
      })
      .returning();

    const now = new Date();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000,
      spentPaise: 0,
      perTransactionMaxPaise: 100_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    });

    console.log(`Merchant "${merchant.name}" signed up but has not connected a Razorpay account.\n`);
    console.log(`Agent "${agent.name}" attempts a perfectly ordinary ₹500 purchase.\n`);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 50_000,
      context: "House Blend Espresso (500g)",
    });

    console.log(`Gate decision: ${result.decision.toUpperCase()}`);
    console.log(`Reason: ${result.reason}\n`);

    if (result.decision !== "deny" || !result.reason.includes("Razorpay account")) {
      throw new Error(`Expected a deny naming the missing Razorpay connection, got: ${result.decision} — ${result.reason}`);
    }

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    if (cap.spentPaise !== 0) {
      throw new Error("Expected no budget to be reserved — the credentials check must run before reservation");
    }
    console.log(`Cap balance untouched: ₹${(cap.spentPaise / 100).toFixed(2)} spent of ₹${(cap.capPaise / 100).toFixed(2)}. No reservation was ever taken.\n`);

    const trail = await getRecentAuditEntries(merchant.id, 5);
    const entry = trail.find((e) => e.reason === result.reason);
    console.log("Audit trail entry confirming this was logged:");
    console.log(`  [${entry?.decision.toUpperCase()}] ${entry?.reason}`);
    console.log(`  Bound applied: ${entry?.boundApplied}\n`);

    console.log("No money moved. No order was attempted. The merchant sees exactly what to do next: connect Razorpay in Settings.");
  } finally {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchant.id));
    await db
      .delete(schema.spendCaps)
      .where(inArray(schema.spendCaps.agentId, db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchant.id))));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchant.id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
