import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { sweepAbandonedReservations, RESERVATION_TIMEOUT_MINUTES } from "@/lib/gate";

/**
 * Layer 23-2's required failure demo: an agent's reservation is taken
 * (budget and stock both reserved, a real money_actions row written at
 * status "allowed") and the process handling it never comes back —
 * exactly what happens when a serverless instance times out, OOMs, or
 * is killed mid-deploy between reserving and calling Razorpay.
 * executeAndSettle's own try/catch can't run in that case; there's no
 * process left to run it. sweepAbandonedReservations is the only thing
 * that finds this row and gives the reservation back.
 *
 * The reservation is built by hand here (budget/stock decremented,
 * money_actions inserted at "allowed") rather than by calling
 * attemptMoneyAction and killing the process — that would need two
 * processes to demonstrate. The steps mirror exactly what
 * attemptMoneyAction does internally up to the point executeAndSettle
 * would run; see gate.ts's own reservation-sweep tests for the same
 * simulation used against real concurrent sweeps.
 */
async function main() {
  console.log("=== Demo: an agent's reservation is stranded and swept ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId: merchant.id,
      name: "Demo Product — Abandoned Reservation Scenario",
      description: "For the stranded-reservation sweep demo.",
      status: "active",
    })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: merchant.id,
      sku: `demo-reservation-${Date.now()}`,
      pricePaise: 60_000,
      costPaise: 25_000,
      stock: 5,
      status: "active",
    })
    .returning();

  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent — Abandoned Reservation Scenario", apiKeyHash: `demo_reservation_${Date.now()}`, status: "active" })
    .returning();

  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: agent.id,
      capPaise: 1_000_000,
      spentPaise: 0,
      perTransactionMaxPaise: 1_000_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();

  const quantity = 2;
  const amountPaise = variant.pricePaise * quantity;

  try {
    console.log(`1. Reserving budget and stock for a ${quantity}x purchase (₹${(amountPaise / 100).toFixed(2)}) — the same atomic reservation attemptMoneyAction takes before calling Razorpay:`);
    await db
      .update(schema.spendCaps)
      .set({ spentPaise: sql`${schema.spendCaps.spentPaise} + ${amountPaise}` })
      .where(eq(schema.spendCaps.id, cap.id));
    await db
      .update(schema.productVariants)
      .set({ stock: sql`${schema.productVariants.stock} - ${quantity}` })
      .where(eq(schema.productVariants.id, variant.id));

    const [afterReserve] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    const [variantAfterReserve] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    console.log(`   spend cap: ₹${(afterReserve.spentPaise / 100).toFixed(2)} reserved. Stock: ${variantAfterReserve.stock} of 5 remaining.\n`);

    console.log("2. Writing the money_actions row at status \"allowed\" — reservation taken, execution not yet attempted:");
    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({
        merchantId: merchant.id,
        agentId: agent.id,
        variantId: variant.id,
        quantity,
        type: "order_create",
        amountPaise,
        status: "allowed",
        // Backdated into the past, standing in for real time passing
        // with no process left to ever call executeAndSettle — this is
        // the only line that differs from what attemptMoneyAction does
        // for real; everything else in this demo is the real path.
        reservationExpiresAt: sql`now() - interval '1 minute'`,
      })
      .returning();
    console.log(`   money_actions ${moneyAction.id} — status: "${moneyAction.status}", reservationExpiresAt already past (would normally be ${RESERVATION_TIMEOUT_MINUTES} minutes out).\n`);

    console.log("3. The process that should have called Razorpay next never comes back — no crash to catch, nothing to release the reservation from inside attemptMoneyAction.\n");

    console.log("4. Running the real sweep (/api/cron/run's reservations:sweep-abandoned job):");
    const { swept } = await sweepAbandonedReservations();
    console.log(`   swept: ${swept}\n`);
    if (swept < 1) throw new Error("Expected the sweep to find and release our stranded reservation — demo scenario is broken");

    const [releasedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    const [releasedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    const [releasedAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));

    console.log("5. Reading back the released state:");
    console.log(`   spend cap: ₹${(releasedCap.spentPaise / 100).toFixed(2)} reserved (back to 0)`);
    console.log(`   stock: ${releasedVariant.stock} of 5 (back to full)`);
    console.log(`   money_actions status: "${releasedAction.status}" (was "allowed")\n`);

    if (releasedCap.spentPaise !== 0) throw new Error(`Expected budget released back to 0, got ${releasedCap.spentPaise} — demo scenario is broken`);
    if (releasedVariant.stock !== 5) throw new Error(`Expected stock released back to 5, got ${releasedVariant.stock} — demo scenario is broken`);
    if (releasedAction.status !== "failed") throw new Error(`Expected status "failed", got "${releasedAction.status}" — demo scenario is broken`);

    console.log("6. Reading back the real audit_log entry naming the exact bound:");
    const [auditEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    if (!auditEntry) throw new Error("Expected a real reservation_abandoned audit entry — demo scenario is broken");
    console.log(`   "${auditEntry.reason}"`);
    console.log(`   boundApplied: "${auditEntry.boundApplied}"\n`);
    if (auditEntry.boundApplied !== "reservation_timeout") {
      throw new Error(`Expected boundApplied "reservation_timeout", got "${auditEntry.boundApplied}" — demo scenario is broken`);
    }

    console.log(
      "A reservation stranded by a dead process — not a code path that threw, one that never got the chance to run at all — was still found, deterministically released, and audited. The stock and budget it held never stayed locked indefinitely.",
    );
  } finally {
    await db.delete(schema.auditLog).where(and(eq(schema.auditLog.merchantId, merchant.id), sql`${schema.auditLog.metadata}->>'agentId' = ${agent.id}`));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
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
