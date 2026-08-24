import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { runRecoveryForFailure } from "@/lib/recovery/sequencer";
import { getRecentAuditEntries } from "@/lib/audit";

/**
 * Track 03's "stopping rules" demo: a payment fails, the recovery agent
 * tries once, tries again — then stops itself, on purpose, by arithmetic.
 * Every other recovery demo shows money coming back; this one shows the
 * agent refusing to keep spending on a payment that isn't worth chasing
 * further. Repeatable, self-cleaning — run any number of times for the
 * pitch video.
 */
async function main() {
  console.log("=== Demo: recovery agent stops itself after its attempt limit ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [failure] = await db
    .insert(schema.paymentFailures)
    .values({
      merchantId: merchant.id,
      amountPaise: 150_000, // ₹1500, above the minimum-recoverable floor and well below the high-value threshold
      declineCode: "GATEWAY_TIMEOUT_ERROR",
      declineDescription: "The request timed out at the gateway.",
      source: "simulated",
      status: "new",
      failedAt: new Date(),
    })
    .returning();

  try {
    console.log(`Payment of ₹${(failure.amountPaise / 100).toFixed(2)} failed: ${failure.declineDescription} (${failure.declineCode})\n`);
    console.log("Running the recovery pipeline against this failure repeatedly, simulating its backoff schedule elapsing between each attempt...\n");

    let lastOutcome;
    for (let i = 1; i <= 4; i++) {
      // The policy's real backoff schedule holds each next attempt for
      // hours; for a scripted demo that runs in seconds, clear the
      // previous attempt's nextAttemptAt so this run isn't just waiting
      // on a real clock. The stopping rule under test here is the
      // attempt ceiling, not the backoff window — this only fast-forwards
      // past a rule the demo isn't about.
      await db.update(schema.recoveryAttempts).set({ nextAttemptAt: new Date(0) }).where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));

      lastOutcome = await runRecoveryForFailure(merchant.id, failure.id);
      console.log(`Attempt ${i}: ${lastOutcome.proceeded ? `strategy "${lastOutcome.strategy}", outcome "${lastOutcome.outcome}"` : "stopped"}`);
      console.log(`  ${lastOutcome.reason}\n`);

      if (!lastOutcome.proceeded) break;
    }

    if (!lastOutcome || lastOutcome.proceeded) {
      throw new Error("Expected the agent to eventually stop itself — demo scenario is broken");
    }

    const trail = await getRecentAuditEntries(merchant.id, 10);
    const stopEntry = trail.find((e) => e.event === "recovery_stopped" && e.reason === lastOutcome!.reason);
    console.log("Audit trail entry confirming the stop was logged:");
    console.log(`  [${stopEntry?.decision.toUpperCase()}] ${stopEntry?.reason}`);
    console.log(`  Bound applied: ${stopEntry?.boundApplied}\n`);

    console.log("The agent stopped on its own, by rule, not because anything crashed.");
    console.log("No further money will be spent chasing this payment — the deterministic policy in src/lib/recovery/policy.ts made that call, not a model.\n");
  } finally {
    // Money-moving strategies route through the merchant's lazily
    // provisioned recovery agent (see getOrCreateRecoveryAgent in
    // sequencer.ts), which is left in place for reuse across runs — but
    // the money_actions/escalations rows this specific demo run created
    // against it are cleaned up here, same as the other demo-failure-*
    // scripts clean up what they created.
    const attempts = await db
      .select({ id: schema.recoveryAttempts.id, moneyActionId: schema.recoveryAttempts.moneyActionId })
      .from(schema.recoveryAttempts)
      .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));

    const moneyActionIds = attempts.map((a) => a.moneyActionId).filter((id): id is string => id !== null);

    // recovery_attempts.money_action_id FKs into money_actions, so
    // recovery_attempts must go first.
    if (attempts.length > 0) {
      await db.delete(schema.recoveryAttempts).where(inArray(schema.recoveryAttempts.id, attempts.map((a) => a.id)));
    }
    await db.delete(schema.paymentFailures).where(eq(schema.paymentFailures.id, failure.id));

    if (moneyActionIds.length > 0) {
      await db.delete(schema.escalations).where(inArray(schema.escalations.moneyActionId, moneyActionIds));
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, moneyActionIds));
      await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, moneyActionIds));
    }
  }

  console.log("=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
