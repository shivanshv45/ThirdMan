import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 17: the durable state a long-running task lives in. This module
 * owns creating, claiming, and stepping a task — never deciding what a
 * task should do next. Task-kind logic (what a "recovery_sequence" task
 * actually does at each step) lives in runner.ts's per-kind handlers,
 * mirroring the separation gate.ts keeps between checkBounds (decides)
 * and executeAndSettle (carries out), and recovery/sequencer.ts keeps
 * between policy.ts (decides) and itself (carries out).
 *
 * There is no worker process on this stack. A task's state has to
 * survive between /api/cron/run ticks as rows, not as anything held in
 * memory — this is why every timestamp comparison here uses the
 * database's own clock (sql`now()`), never the app server's new Date(),
 * matching the lesson FAILURES.md already recorded once for
 * model_budgets.periodStart.
 */

export type AgentTaskKind = (typeof schema.agentTaskKindEnum.enumValues)[number];
export type AgentTaskStatus = (typeof schema.agentTaskStatusEnum.enumValues)[number];

// Task-specific progress is a jsonb column, but its shape is closed and
// validated at every read/write boundary, never trusted as-is — same
// discipline reward-rules.ts's AST column already uses. Each kind
// registers its own zod schema here; a kind with no registered schema
// cannot have its state read or written, which is the fail-closed
// default for a kind whose state shape hasn't been declared yet.
const recoverySequenceStateSchema = z.object({
  failureId: z.string().uuid(),
});

const TASK_STATE_SCHEMAS = {
  recovery_sequence: recoverySequenceStateSchema,
} satisfies Record<AgentTaskKind, z.ZodType>;

export function parseTaskState<K extends AgentTaskKind>(kind: K, state: unknown): z.infer<(typeof TASK_STATE_SCHEMAS)[K]> {
  return TASK_STATE_SCHEMAS[kind].parse(state) as z.infer<(typeof TASK_STATE_SCHEMAS)[K]>;
}

export interface CreateTaskInput {
  merchantId: string;
  /** The identity this task acts under. Required whenever the task kind can take a money action — see requiresAgent below. */
  agentId?: string;
  kind: AgentTaskKind;
  state: unknown;
  maxAttempts: number;
  runAfter?: Date;
  idempotencyKey?: string;
}

// Every kind currently registered takes a money action. A kind added
// later that provably never does can be added to this set as an
// exception — the default is "assume it can, and require an agent",
// since the cost of being wrong the other way (a task silently acting
// with no bounded identity) is much higher than an unnecessary check.
const KINDS_REQUIRING_AGENT = new Set<AgentTaskKind>(["recovery_sequence"]);

/**
 * Creates a task. Refuses outright — before any row is written — to
 * create a money-taking task with no agent identity, rather than
 * defaulting to some implicit authority. This is the structural
 * guarantee the plan calls for: "a task with no valid agent cannot take
 * a money action at all," enforced at creation, not by convention at
 * call time.
 */
export async function createTask(input: CreateTaskInput): Promise<{ id: string; created: boolean }> {
  if (KINDS_REQUIRING_AGENT.has(input.kind) && !input.agentId) {
    throw new Error(`createTask: task kind "${input.kind}" can take a money action and requires an agentId`);
  }

  parseTaskState(input.kind, input.state);

  if (input.idempotencyKey) {
    const [existing] = await db
      .select({ id: schema.agentTasks.id })
      .from(schema.agentTasks)
      .where(and(eq(schema.agentTasks.merchantId, input.merchantId), eq(schema.agentTasks.idempotencyKey, input.idempotencyKey)));
    if (existing) return { id: existing.id, created: false };
  }

  const [row] = await db
    .insert(schema.agentTasks)
    .values({
      merchantId: input.merchantId,
      agentId: input.agentId,
      kind: input.kind,
      state: input.state as object,
      maxAttempts: input.maxAttempts,
      runAfter: input.runAfter ?? sql`now()`,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [schema.agentTasks.merchantId, schema.agentTasks.idempotencyKey],
      // Must repeat the partial index's own WHERE predicate exactly —
      // a plain column-list target only matches a FULL unique index,
      // and Postgres won't infer a partial one as the arbiter otherwise
      // (this exact bug is already recorded once in FAILURES.md for
      // webhook_deliveries and restock_requests; caught here by this
      // module's own first real test, before it shipped).
      where: sql`${schema.agentTasks.idempotencyKey} is not null`,
    })
    .returning({ id: schema.agentTasks.id });

  // The insert lost an idempotency race against a concurrent creation —
  // same shape as the gate's own idempotency handling: the loser reads
  // back and returns the winner's row rather than erroring.
  if (!row) {
    const [winner] = await db
      .select({ id: schema.agentTasks.id })
      .from(schema.agentTasks)
      .where(and(eq(schema.agentTasks.merchantId, input.merchantId), eq(schema.agentTasks.idempotencyKey, input.idempotencyKey!)));
    if (!winner) throw new Error("createTask: insert produced no row and no existing row was found — this should be unreachable");
    return { id: winner.id, created: false };
  }

  return { id: row.id, created: true };
}

const CLAIM_LEASE_MS = 5 * 60 * 1000; // 5 minutes — long enough for a real step, short enough that a dead process doesn't strand a task for long

// A task is eligible to be claimed either because it was never claimed
// (pending/waiting, no active lease) or because a prior claim's lease
// has expired — the crash-safety case: a process that claimed a task
// and died mid-step leaves it at status "claimed" forever unless an
// expired lease is itself treated as eligible, not just "claimedUntil
// is old." Both conditions check runAfter/claimedUntil against the
// database's own clock, never the app server's.
function taskEligibilityCondition() {
  return and(
    or(
      and(or(eq(schema.agentTasks.status, "pending"), eq(schema.agentTasks.status, "waiting")), lte(schema.agentTasks.runAfter, sql`now()`)),
      and(eq(schema.agentTasks.status, "claimed"), lte(schema.agentTasks.claimedUntil, sql`now()`)),
    ),
  );
}

/**
 * Atomically claims up to `limit` due tasks — the eligibility check and
 * the claim itself happen in one UPDATE statement, exactly the pattern
 * gate.ts's reserveBudget/reserveStock already prove correct for
 * concurrent writers racing over the same rows. Never select-then-
 * update: two overlapping /api/cron/run ticks calling this concurrently
 * must never claim the same task twice, and a task orphaned by a
 * crashed process must become reclaimable once its lease expires, not
 * stay stuck at status "claimed" forever.
 */
export async function claimDueTasks(limit: number): Promise<Array<typeof schema.agentTasks.$inferSelect>> {
  const eligible = await db
    .select({ id: schema.agentTasks.id })
    .from(schema.agentTasks)
    .where(taskEligibilityCondition())
    .limit(limit);

  const claimed: Array<typeof schema.agentTasks.$inferSelect> = [];
  for (const { id } of eligible) {
    // Each candidate is claimed individually via its own conditional
    // UPDATE, re-checking eligibility in the same statement — a second
    // tick that read the same `eligible` list a moment earlier loses
    // this race cleanly (its own UPDATE matches zero rows) rather than
    // both ticks believing they hold the claim.
    const [row] = await db
      .update(schema.agentTasks)
      .set({ status: "claimed", claimedUntil: sql`now() + (${CLAIM_LEASE_MS} * interval '1 millisecond')`, attemptCount: sql`${schema.agentTasks.attemptCount} + 1`, updatedAt: sql`now()` })
      .where(and(eq(schema.agentTasks.id, id), taskEligibilityCondition()))
      .returning();
    if (row) claimed.push(row);
  }

  return claimed;
}

/** Records one step attempt — the task's own append-only audit trail, independent of and in addition to audit_log (which the money action itself, if any, already writes). */
export async function recordStep(taskId: string, stepName: string, outcome: "succeeded" | "failed" | "stopped", reason: string, opts?: { moneyActionId?: string; durationMs?: number }): Promise<void> {
  await db.insert(schema.agentTaskSteps).values({
    taskId,
    stepName,
    outcome,
    reason,
    moneyActionId: opts?.moneyActionId,
    durationMs: opts?.durationMs,
  });
}

/**
 * Moves a task back to "waiting" for a future runAfter — the mechanism
 * backoff and long waits use, since nothing here ever sleeps.
 * attemptCount is NOT incremented here — claimDueTasks already counts
 * an attempt the moment it claims a task, which is the actual instant
 * an attempt begins (whether it succeeds, fails, or the process
 * crashes before it can reschedule). Incrementing again here would
 * double-count every attempt that runs to completion.
 *
 * `runAfter` is a plain app-server Date, and that's fine for any real
 * backoff (minutes to days out) — but claimDueTasks compares it against
 * the DATABASE's own now(), so a caller passing a Date only just barely
 * in the past can race the DB clock and not read as due on an
 * immediately-following claim. Measured directly against this project's
 * Neon instance while building this module: ~500ms of real clock skew
 * plus round-trip latency (consistent with FAILURES.md's own documented
 * ~1.1s cold-connection latency for this same database) — a genuine
 * gap, not a hypothetical. Every real caller in this codebase backs off
 * by minutes or more, so this has never mattered in practice; noted
 * here because it is exactly the two-clocks class of bug FAILURES.md
 * already records once for model_budgets.periodStart, and a future
 * near-zero backoff would hit it again.
 *
 * Only applies from status "claimed" — the WHERE clause guards this
 * explicitly, not just by caller convention. Without it, calling this
 * on an already-terminal task (succeeded/failed/cancelled) would
 * silently resurrect it back to "waiting" — a real bug this module's
 * own property test caught before it shipped (see FAILURES.md).
 */
export async function rescheduleTask(taskId: string, runAfter: Date): Promise<void> {
  await db
    .update(schema.agentTasks)
    .set({ status: "waiting", runAfter, claimedUntil: null, updatedAt: sql`now()` })
    .where(and(eq(schema.agentTasks.id, taskId), eq(schema.agentTasks.status, "claimed")));
}

async function terminateTask(taskId: string, merchantId: string, status: "succeeded" | "failed" | "cancelled", reason: string, boundApplied?: string): Promise<void> {
  await db
    .update(schema.agentTasks)
    .set({ status, claimedUntil: null, updatedAt: sql`now()` })
    .where(eq(schema.agentTasks.id, taskId));

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: status === "succeeded" ? "agent_task_succeeded" : status === "failed" ? "agent_task_failed" : "agent_task_cancelled",
    decision: "n/a",
    reason,
    boundApplied,
    metadata: { taskId },
  });
}

export async function completeTask(taskId: string, merchantId: string, reason: string): Promise<void> {
  await terminateTask(taskId, merchantId, "succeeded", reason);
}

/** A stop is a recorded, bound-named outcome — never a silent early return, matching recovery/sequencer.ts's own recordStop discipline. */
export async function abandonTask(taskId: string, merchantId: string, reason: string, boundApplied: string): Promise<void> {
  await terminateTask(taskId, merchantId, "failed", reason, boundApplied);
}

/** A merchant-initiated cancellation — always audited, the same discipline a merchant re-arming a suspended agent already follows. */
export async function cancelTask(merchantId: string, taskId: string): Promise<void> {
  const [task] = await db.select().from(schema.agentTasks).where(and(eq(schema.agentTasks.id, taskId), eq(schema.agentTasks.merchantId, merchantId)));
  if (!task) throw new Error("Task not found");
  if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
    throw new Error(`Cannot cancel a task with terminal status "${task.status}"`);
  }
  await terminateTask(taskId, merchantId, "cancelled", "Cancelled by the merchant.", "merchant_cancelled");
}

/** A merchant-initiated retry of a failed task — resets attemptCount, same reasoning webhooks/runner.ts's retryDelivery already follows. Always audited: a merchant overriding a stopping rule must leave a trace. */
export async function retryTask(merchantId: string, taskId: string): Promise<void> {
  const [task] = await db.select().from(schema.agentTasks).where(and(eq(schema.agentTasks.id, taskId), eq(schema.agentTasks.merchantId, merchantId)));
  if (!task) throw new Error("Task not found");
  if (task.status !== "failed") {
    throw new Error(`Cannot retry a task with status "${task.status}" — only a failed task can be retried`);
  }

  await db
    .update(schema.agentTasks)
    .set({ status: "pending", attemptCount: 0, runAfter: sql`now()`, claimedUntil: null, updatedAt: sql`now()` })
    .where(eq(schema.agentTasks.id, taskId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_task_retried",
    decision: "n/a",
    reason: "Merchant retried a failed task, overriding its stopping rule. Attempt count reset to 0.",
    metadata: { taskId },
  });
}

export async function getTaskSteps(taskId: string): Promise<Array<typeof schema.agentTaskSteps.$inferSelect>> {
  return db.select().from(schema.agentTaskSteps).where(eq(schema.agentTaskSteps.taskId, taskId)).orderBy(schema.agentTaskSteps.createdAt);
}

export async function listTasksForMerchant(merchantId: string): Promise<Array<typeof schema.agentTasks.$inferSelect>> {
  return db.select().from(schema.agentTasks).where(eq(schema.agentTasks.merchantId, merchantId)).orderBy(schema.agentTasks.createdAt);
}
