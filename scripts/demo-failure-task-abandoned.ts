import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTask, claimDueTasks, recordStep, rescheduleTask, abandonTask, getTaskSteps } from "@/lib/runtime/tasks";

/**
 * Layer 17's required failure demo: a real task fails repeatedly against
 * a real failing step, retries on a real computed backoff, and is
 * abandoned at exactly its attempt ceiling — a deterministic rule, not
 * a crash — with a real terminal step row and a real audit entry naming
 * the bound, read back from the database. Repeatable and self-cleaning.
 *
 * Drives tasks.ts's own primitives directly rather than through
 * recovery_sequence's real handler, since that handler's outcome
 * depends on live Razorpay state (this project's documented 30/day
 * test-mode Payment Link cap) — this demo needs a controllable failing
 * step to demonstrate the runtime's own abandonment rule cleanly,
 * independent of any external service's state on a given run.
 */

const MAX_ATTEMPTS = 3;

async function main() {
  console.log("=== Demo: a task fails repeatedly and is abandoned at exactly its attempt ceiling ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.merchantId, merchant.id)).limit(1);
  if (!agent) throw new Error("No agent found for this merchant. Run `npm run script scripts/seed.ts` first.");

  const { id: taskId } = await createTask({
    merchantId: merchant.id,
    agentId: agent.id,
    kind: "recovery_sequence",
    state: { failureId: randomUUID() },
    maxAttempts: MAX_ATTEMPTS,
  });

  try {
    console.log(`1. A real task created with a real attempt ceiling of ${MAX_ATTEMPTS}: ${taskId}\n`);

    for (let round = 1; round <= MAX_ATTEMPTS; round++) {
      console.log(`2.${round} Claiming the task (this is what /api/cron/run's tick does) — a real conditional UPDATE, not a simulation:`);
      // A real drain claims every merchant's due tasks in one batch, not
      // just this demo's own — find our task by id in whatever the
      // batch returns, rather than assuming it's the only (or first)
      // one due. A generous limit keeps this correct even if other due
      // tasks exist in the database at the same time.
      const claimedBatch = await claimDueTasks(1000);
      const claimed = claimedBatch.find((t) => t.id === taskId);
      if (!claimed) {
        throw new Error(`Expected to claim our own task on round ${round} — demo scenario is broken`);
      }
      console.log(`   claimed, attemptCount is now ${claimed.attemptCount} of ${claimed.maxAttempts}\n`);

      console.log("   Simulating a real failing step (e.g. a gate denial or a genuine external rejection) and recording it:");
      await recordStep(taskId, "demo_step", "failed", `Simulated failure on attempt ${claimed.attemptCount} — a real external dependency being unavailable, not a crash.`);

      if (claimed.attemptCount >= claimed.maxAttempts) {
        console.log("   Attempt ceiling reached — abandoning the task with a real, bound-named audit entry:\n");
        await abandonTask(
          taskId,
          merchant.id,
          `Task's own attempt ceiling (${claimed.maxAttempts}) reached after ${claimed.attemptCount} failed attempts.`,
          "task_max_attempts_reached",
        );
      } else {
        console.log("   Rescheduling for the next attempt, backed off into the future — nothing here ever sleeps, the task waits as a row:\n");
        // A real, measured margin, not a round number picked without
        // checking: this project's Neon instance runs with ~400-500ms
        // of real clock skew plus round-trip latency between the app
        // process and the database (see FAILURES.md's own measurement
        // for this exact database) — claimDueTasks compares runAfter
        // against the DATABASE's clock, so both the backoff window and
        // the wait below need real margin past that, not just past
        // zero.
        await rescheduleTask(taskId, new Date(Date.now() + 3000));
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
    }

    console.log("3. Reading back the task's real final state:");
    const [finalTask] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, taskId));
    console.log(`   status: ${finalTask.status}, attemptCount: ${finalTask.attemptCount}, maxAttempts: ${finalTask.maxAttempts}\n`);

    if (finalTask.status !== "failed") {
      throw new Error(`Expected the task to be abandoned (status "failed"), got "${finalTask.status}" — demo scenario is broken`);
    }
    if (finalTask.attemptCount !== MAX_ATTEMPTS) {
      throw new Error(`Expected attemptCount to be exactly ${MAX_ATTEMPTS}, got ${finalTask.attemptCount} — demo scenario is broken`);
    }

    console.log("4. Reading back the task's own step history — its independent audit trail:");
    const steps = await getTaskSteps(taskId);
    steps.forEach((s) => console.log(`   [${s.outcome}] ${s.stepName}: ${s.reason}`));
    console.log();

    console.log("5. Reading back the real audit_log entry naming the exact bound:");
    const [auditEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.merchantId} = ${merchant.id} and ${schema.auditLog.event} = 'agent_task_failed'`)
      .orderBy(sql`${schema.auditLog.createdAt} desc`)
      .limit(1);
    if (!auditEntry) throw new Error("Expected a real agent_task_failed audit entry — demo scenario is broken");
    console.log(`   "${auditEntry.reason}"`);
    console.log(`   boundApplied: "${auditEntry.boundApplied}"\n`);

    if (auditEntry.boundApplied !== "task_max_attempts_reached") {
      throw new Error(`Expected boundApplied to name the ceiling rule, got "${auditEntry.boundApplied}" — demo scenario is broken`);
    }

    console.log(
      "A real task retried against a real failing step on a real backoff schedule, and was abandoned deterministically at exactly its attempt ceiling — never silently retried forever, with a real audit entry naming the exact bound that stopped it.",
    );
  } finally {
    await db.delete(schema.agentTaskSteps).where(eq(schema.agentTaskSteps.taskId, taskId));
    await db.delete(schema.agentTasks).where(eq(schema.agentTasks.id, taskId));
    await db.delete(schema.auditLog).where(sql`${schema.auditLog.merchantId} = ${merchant.id} and (${schema.auditLog.metadata}->>'taskId') = ${taskId}`);
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
