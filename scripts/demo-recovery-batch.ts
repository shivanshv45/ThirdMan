import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { loadDemoFailureBatch } from "@/lib/recovery/demo-batch";
import { runRecoveryBatch } from "@/lib/recovery/sequencer";
import { getRecoveryStats } from "@/lib/recovery/attribution";

/**
 * The Track 03 pitch-video shot: load a batch of failed payments, run
 * the recovery pipeline against all of them in one call, and print the
 * measured result — attempted, recovered, written off, and exactly which
 * deterministic rule stopped each one that didn't proceed. Repeatable,
 * self-cleaning.
 */
async function main() {
  console.log("=== Demo: revenue recovery batch ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const failureIdsBefore = (
    await db.select({ id: schema.paymentFailures.id }).from(schema.paymentFailures).where(eq(schema.paymentFailures.merchantId, merchant.id))
  ).map((f) => f.id);

  try {
    const count = await loadDemoFailureBatch(merchant.id);
    console.log(`Loaded ${count} simulated failed payments (labelled "simulated" — no live checkout exists yet to produce real declines; every recovery attempt against them is real).\n`);

    const result = await runRecoveryBatch(merchant.id);

    console.log("Batch result:");
    console.log(`  Attempted:        ${result.attempted}`);
    console.log(`  Succeeded:        ${result.succeeded}`);
    console.log(`  Recovered:        ₹${(result.recoveredPaise / 100).toFixed(2)}`);
    console.log(`  Written off:      ${result.writtenOff}`);
    console.log("  Stopped by rule:");
    for (const [rule, count] of Object.entries(result.stoppedByRule)) {
      console.log(`    ${rule}: ${count}`);
    }

    // Real, payable links (Layer 4-3) — a real customer completing one
    // of these is what flips it from "pending" to "succeeded" via the
    // payment_link.paid webhook. Printed here so the demo shows the
    // artifact that makes the recovered figure genuinely reachable.
    const pendingLinks = await db
      .select({ url: schema.recoveryAttempts.paymentLinkUrl })
      .from(schema.recoveryAttempts)
      .where(inArray(schema.recoveryAttempts.paymentFailureId, (await db.select({ id: schema.paymentFailures.id }).from(schema.paymentFailures).where(eq(schema.paymentFailures.merchantId, merchant.id))).map((f) => f.id)));
    const links = pendingLinks.map((p) => p.url).filter((u): u is string => u !== null);
    if (links.length > 0) {
      console.log(`\n  ${links.length} real, payable Razorpay Payment Link(s) generated this run:`);
      for (const url of links) console.log(`    ${url}`);
      console.log("  Paying one of these (test mode) is what moves it from pending to succeeded — see /dashboard/recovery.");
    }

    const stats = await getRecoveryStats(merchant.id);
    console.log("\nAttribution (merchant-scoped, summed from verified recovery_attempts rows only):");
    console.log(`  ₹${(stats.recoveredPaise / 100).toFixed(2)} of ₹${(stats.totalFailedPaise / 100).toFixed(2)} recovered — ${stats.recoveryRatePercent}%`);
    console.log(`  ${stats.attemptsDeclined} attempts deliberately not made (the restraint the deterministic policy in policy.ts enforces)\n`);

    console.log("Every one of these numbers traces back to a real recovery_attempts row, each written after a real gate call or a real stopping-rule check — none of it is a status flip on a database row.");
  } finally {
    const failuresNow = await db.select({ id: schema.paymentFailures.id }).from(schema.paymentFailures).where(eq(schema.paymentFailures.merchantId, merchant.id));
    const demoFailureIds = failuresNow.map((f) => f.id).filter((id) => !failureIdsBefore.includes(id));

    if (demoFailureIds.length > 0) {
      const attempts = await db
        .select({ id: schema.recoveryAttempts.id, moneyActionId: schema.recoveryAttempts.moneyActionId })
        .from(schema.recoveryAttempts)
        .where(inArray(schema.recoveryAttempts.paymentFailureId, demoFailureIds));

      if (attempts.length > 0) {
        await db.delete(schema.recoveryAttempts).where(inArray(schema.recoveryAttempts.id, attempts.map((a) => a.id)));
      }
      await db.delete(schema.paymentFailures).where(inArray(schema.paymentFailures.id, demoFailureIds));

      const moneyActionIds = attempts.map((a) => a.moneyActionId).filter((id): id is string => id !== null);
      if (moneyActionIds.length > 0) {
        await db.delete(schema.escalations).where(inArray(schema.escalations.moneyActionId, moneyActionIds));
        await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, moneyActionIds));
        await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, moneyActionIds));
      }
    }
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
