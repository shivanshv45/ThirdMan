import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTask, claimDueTasks, recordStep, completeTask, abandonTask, rescheduleTask, parseTaskState, type AgentTaskKind } from "@/lib/runtime/tasks";
import { runRecoveryForFailure, getOrCreateRecoveryAgent } from "@/lib/recovery/sequencer";
import { MAX_ATTEMPTS_PER_FAILURE } from "@/lib/recovery/policy";

/**
 * Layer 17-2: trigger-agnostic drain, registered in /api/cron/run's job
 * list exactly like webhooks/runner.ts's drainDueDeliveries — no worker
 * process of its own. Every bound here (claim limit, retry ceiling,
 * backoff, abandonment) is deterministic code; no model decides any of
 * it.
 *
 * A step is a pure decision plus an effect, mirroring the separation
 * gate.ts keeps between checkBounds and executeAndSettle: this file
 * only calls into each kind's own decision-making module
 * (recovery/policy.ts via recovery/sequencer.ts) and records the
 * outcome — it never re-implements a bound.
 */

const CLAIM_BATCH_LIMIT = 20;

/**
 * Creates a recovery_sequence task for one failure — the task's own
 * agentId is resolved to the same hidden __recovery_pipeline agent
 * runRecoveryForFailure already acts as, so the identity a task is
 * created under and the identity that actually takes its money actions
 * are the same real row, not two different things that happen to agree
 * today. Idempotent by failureId: calling this twice for the same
 * failure returns the existing task rather than creating a second
 * runner racing the first.
 */
export async function createRecoverySequenceTask(merchantId: string, failureId: string): Promise<{ id: string; created: boolean }> {
  const recoveryAgent = await getOrCreateRecoveryAgent(merchantId);
  return createTask({
    merchantId,
    agentId: recoveryAgent.id,
    kind: "recovery_sequence",
    state: { failureId },
    maxAttempts: MAX_ATTEMPTS_PER_FAILURE,
    idempotencyKey: `recovery_sequence:${failureId}`,
  });
}

type StepHandler = (task: typeof schema.agentTasks.$inferSelect) => Promise<void>;

/**
 * recovery_sequence: one step is one call to runRecoveryForFailure,
 * which itself calls into recovery/policy.ts for every bound (attempt
 * ceiling, backoff, ROI governor, high-value escalation) — this handler
 * carries the decision out and translates it into the task's own
 * status, never re-deciding anything.
 */
async function stepRecoverySequence(task: typeof schema.agentTasks.$inferSelect): Promise<void> {
  const state = parseTaskState("recovery_sequence", task.state);
  const startedAt = Date.now();

  const outcome = await runRecoveryForFailure(task.merchantId, state.failureId);
  const durationMs = Date.now() - startedAt;

  // A stop from policy.ts (attempt ceiling, ROI governor, unrecoverable
  // diagnosis, high-value escalation, already-resolved) is a terminal,
  // bound-named outcome — the task ends here, matching how
  // recovery/sequencer.ts's own recordStop already treats it as a
  // first-class result, not a silent early return.
  if (!outcome.proceeded) {
    await recordStep(task.id, "recovery_attempt", "stopped", outcome.reason, { durationMs });
    await abandonTask(task.id, task.merchantId, outcome.reason, outcome.stoppingRule ?? "recovery_policy_stop");
    return;
  }

  // human_escalation and write_off are also terminal — nothing further
  // for this task to do, the same way sequencer.ts treats them as
  // final outcomes for the failure itself.
  if (outcome.strategy === "human_escalation" || outcome.strategy === "write_off") {
    await recordStep(task.id, "recovery_attempt", "succeeded", outcome.reason, { durationMs });
    await completeTask(task.id, task.merchantId, outcome.reason);
    return;
  }

  if (outcome.outcome === "succeeded") {
    await recordStep(task.id, "recovery_attempt", "succeeded", outcome.reason, { durationMs });
    await completeTask(task.id, task.merchantId, outcome.reason);
    return;
  }

  if (outcome.outcome === "failed") {
    // A gate denial (cap exhausted, no Razorpay connected) on this
    // attempt — recorded as a normal step outcome, matching how the
    // sequencer itself treats a gate denial as a normal recorded
    // outcome rather than an error. The task's own attemptCount tracks
    // retries independently of recovery_attempts' own attempt number.
    await recordStep(task.id, "recovery_attempt", "failed", outcome.reason, { durationMs });
    // task.attemptCount already reflects this attempt — claimDueTasks
    // increments it at claim time, the actual instant an attempt began,
    // not here after the fact.
    if (task.attemptCount >= task.maxAttempts) {
      await abandonTask(task.id, task.merchantId, `Task's own attempt ceiling (${task.maxAttempts}) reached after a gate denial: ${outcome.reason}`, "task_max_attempts_reached");
      return;
    }
    // Backs off the same amount of wall-clock time the recovery
    // policy's own schedule would use for the next real attempt,
    // without re-implementing that schedule here — it reads back the
    // real recoveryAttempts row runRecoveryForFailure just wrote and
    // reuses its own nextAttemptAt, since that IS the backoff decision.
    const runAfter = await readBackoffFromLatestAttempt(state.failureId);
    await rescheduleTask(task.id, runAfter);
    return;
  }

  // outcome.outcome === "pending" — a real Payment Link was created and
  // is now waiting on the buyer, asynchronously, via the
  // payment_link.paid webhook (confirmRecoveryLinkPaid). This task has
  // nothing further to actively do until either that webhook resolves
  // it or the backoff window for a next attempt (if the link goes
  // unpaid) arrives — reschedule to that next-attempt time exactly like
  // the "failed" branch above, so an unpaid link doesn't leave the task
  // claimable forever with nothing to check.
  await recordStep(task.id, "recovery_attempt", "succeeded", outcome.reason, { durationMs });
  const runAfter = await readBackoffFromLatestAttempt(state.failureId);
  await rescheduleTask(task.id, runAfter);
}

async function readBackoffFromLatestAttempt(failureId: string): Promise<Date> {
  const [failure] = await db.select({ status: schema.paymentFailures.status }).from(schema.paymentFailures).where(eq(schema.paymentFailures.id, failureId));
  // A failure that resolved between the attempt and this read (e.g. the
  // webhook already fired) has nothing left to schedule — 1 hour is a
  // safe, bounded re-check rather than an unbounded or immediate retry.
  if (!failure || failure.status === "recovered" || failure.status === "written_off") {
    return new Date(Date.now() + 60 * 60 * 1000);
  }
  const rows = await db.select({ nextAttemptAt: schema.recoveryAttempts.nextAttemptAt }).from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.paymentFailureId, failureId)).orderBy(schema.recoveryAttempts.attemptNumber);
  const latest = rows[rows.length - 1];
  return latest?.nextAttemptAt ?? new Date(Date.now() + 60 * 60 * 1000);
}

const STEP_HANDLERS: Record<AgentTaskKind, StepHandler> = {
  recovery_sequence: stepRecoverySequence,
};

/**
 * Drains every due task, one kind-specific step each. Isolated per task
 * — one throwing must not stop the rest, matching /api/cron/run's own
 * per-job isolation. A step that throws is recorded as a failed step
 * and the task is rescheduled with its attempt count incremented,
 * abandoned outright once its own ceiling is reached — fail closed,
 * never silently retried forever.
 */
export async function drainDueTasks(): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const tasks = await claimDueTasks(CLAIM_BATCH_LIMIT);
  let succeeded = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      await STEP_HANDLERS[task.kind](task);
      succeeded += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runtime] task ${task.id} (${task.kind}) step threw:`, err);
      await recordStep(task.id, "step_error", "failed", `An unexpected error occurred: ${message}`);
      // task.attemptCount already reflects this attempt — incremented by claimDueTasks at claim time.
      if (task.attemptCount >= task.maxAttempts) {
        await abandonTask(task.id, task.merchantId, `Task's own attempt ceiling (${task.maxAttempts}) reached after an unexpected error: ${message}`, "task_max_attempts_reached");
      } else {
        // A short, fixed backoff on an unexpected error — long enough
        // that a transient DB blip doesn't spin the task, short enough
        // that a real fix doesn't wait hours to take effect.
        await rescheduleTask(task.id, new Date(Date.now() + 5 * 60 * 1000));
      }
    }
  }

  return { claimed: tasks.length, succeeded, failed };
}
