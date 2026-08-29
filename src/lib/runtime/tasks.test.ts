import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTask, claimDueTasks, recordStep, getTaskSteps, completeTask, abandonTask, rescheduleTask, cancelTask, retryTask, listTasksForMerchant, parseTaskState } from "@/lib/runtime/tasks";
import { createTestMerchant } from "@/lib/test-helpers";

// A real, properly-versioned UUID — this zod version's .uuid() enforces
// the RFC version/variant nibbles, so a placeholder like
// "00000000-...0001" fails validation. These tests exercise the task
// state machine only, never runRecoveryForFailure itself, so the id
// need not point at a real payment_failures row.
function fakeFailureId(): string {
  return randomUUID();
}

/**
 * Layer 17-1: the task table and its state machine. No mocks, real DB.
 * The central correctness claim under test throughout: claiming is
 * atomic — the same conditional-UPDATE-with-the-check-in-the-WHERE
 * pattern gate.ts's reserveBudget/reserveStock already prove correct.
 */

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__runtime_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

describe("runtime/tasks", () => {
  let merchantId: string | undefined;
  let taskIds: string[] = [];

  afterEach(async () => {
    for (const id of taskIds) {
      await db.delete(schema.agentTaskSteps).where(eq(schema.agentTaskSteps.taskId, id));
    }
    if (merchantId) {
      await db.delete(schema.agentTasks).where(eq(schema.agentTasks.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
    taskIds = [];
    merchantId = undefined;
  });

  describe("createTask", () => {
    it("refuses a money-taking kind with no agentId, before any row is written", async () => {
      const merchant = await createTestMerchant("__runtime_test_no_agent__");
      merchantId = merchant.id;

      await expect(
        createTask({ merchantId: merchant.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 }),
      ).rejects.toThrow(/requires an agentId/);

      const rows = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.merchantId, merchant.id));
      expect(rows.length).toBe(0);
    });

    it("rejects state that doesn't match the kind's registered zod schema", async () => {
      const merchant = await createTestMerchant("__runtime_test_bad_state__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      await expect(
        createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { notAFailureId: true }, maxAttempts: 3 }),
      ).rejects.toThrow();
    });

    it("idempotencyKey: creating the same logical task twice yields one task, not two", async () => {
      const merchant = await createTestMerchant("__runtime_test_idempotent__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);
      const state = { failureId: fakeFailureId() };

      const first = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state, maxAttempts: 3, idempotencyKey: "dupe-key" });
      taskIds.push(first.id);
      const second = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state, maxAttempts: 3, idempotencyKey: "dupe-key" });

      expect(second.id).toBe(first.id);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);

      const rows = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.merchantId, merchant.id));
      expect(rows.length).toBe(1);
    });

    it("two different merchants can use the identical idempotencyKey without colliding", async () => {
      const merchantA = await createTestMerchant("__runtime_test_idem_a__");
      const merchantB = await createTestMerchant("__runtime_test_idem_b__");
      const agentA = await makeAgent(merchantA.id);
      const agentB = await makeAgent(merchantB.id);
      const state = { failureId: fakeFailureId() };

      const a = await createTask({ merchantId: merchantA.id, agentId: agentA.id, kind: "recovery_sequence", state, maxAttempts: 3, idempotencyKey: "shared-key" });
      const b = await createTask({ merchantId: merchantB.id, agentId: agentB.id, kind: "recovery_sequence", state, maxAttempts: 3, idempotencyKey: "shared-key" });
      expect(a.id).not.toBe(b.id);

      await db.delete(schema.agentTasks).where(eq(schema.agentTasks.id, a.id));
      await db.delete(schema.agentTasks).where(eq(schema.agentTasks.id, b.id));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantA.id));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantB.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantA.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    });
  });

  describe("claimDueTasks", () => {
    it("claims a due, pending task and marks it claimed with a lease", async () => {
      const merchant = await createTestMerchant("__runtime_test_claim__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      const claimed = await claimDueTasks(10);
      const ours = claimed.find((t) => t.id === id);
      expect(ours).toBeDefined();
      expect(ours!.status).toBe("claimed");
      expect(ours!.claimedUntil).not.toBeNull();
    });

    it("does not claim a task whose runAfter is in the future", async () => {
      const merchant = await createTestMerchant("__runtime_test_future__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({
        merchantId: merchant.id,
        agentId: agent.id,
        kind: "recovery_sequence",
        state: { failureId: fakeFailureId() },
        maxAttempts: 3,
        runAfter: new Date(Date.now() + 60 * 60 * 1000),
      });
      taskIds.push(id);

      const claimed = await claimDueTasks(10);
      expect(claimed.find((t) => t.id === id)).toBeUndefined();
    });

    it("does not reclaim a task whose lease has not expired", async () => {
      const merchant = await createTestMerchant("__runtime_test_leased__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      const firstClaim = await claimDueTasks(10);
      expect(firstClaim.find((t) => t.id === id)).toBeDefined();

      const secondClaim = await claimDueTasks(10);
      expect(secondClaim.find((t) => t.id === id)).toBeUndefined();
    });

    it("reclaims a task once its lease has expired (a process that died mid-step)", async () => {
      const merchant = await createTestMerchant("__runtime_test_expired_lease__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      await claimDueTasks(10); // first claim, real lease
      // Simulate a lease that already expired — same DB-clock discipline
      // the module itself uses, not a JS Date, since a real lease
      // comparison always happens against the DB's own now().
      await db.execute(sql`update agent_tasks set claimed_until = now() - interval '1 minute' where id = ${id}`);

      const reclaimed = await claimDueTasks(10);
      expect(reclaimed.find((t) => t.id === id)).toBeDefined();
    });

    it("concurrent claim calls never claim the same task twice", async () => {
      const merchant = await createTestMerchant("__runtime_test_concurrent__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const created = await Promise.all(
        Array.from({ length: 8 }, () =>
          createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 }),
        ),
      );
      taskIds.push(...created.map((c) => c.id));

      // Ten concurrent drains over eight due tasks — every task must be
      // claimed by exactly one caller, never zero, never two.
      const results = await Promise.all(Array.from({ length: 10 }, () => claimDueTasks(20)));
      const claimedIds = results.flat().map((t) => t.id);
      const ourClaimed = claimedIds.filter((id) => created.some((c) => c.id === id));

      expect(ourClaimed.length).toBe(8);
      expect(new Set(ourClaimed).size).toBe(8); // no id claimed twice
    });
  });

  describe("task lifecycle", () => {
    it("recordStep + completeTask: a succeeded task is terminal and writes an audit entry", async () => {
      const merchant = await createTestMerchant("__runtime_test_complete__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      await recordStep(id, "test_step", "succeeded", "it worked");
      await completeTask(id, merchant.id, "done");

      const [task] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id));
      expect(task.status).toBe("succeeded");

      const steps = await getTaskSteps(id);
      expect(steps.length).toBe(1);
      expect(steps[0].outcome).toBe("succeeded");

      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
      expect(audit.some((a) => a.event === "agent_task_succeeded")).toBe(true);
    });

    it("claimDueTasks increments attemptCount at the moment of claiming; rescheduleTask moves to waiting without touching it further", async () => {
      const merchant = await createTestMerchant("__runtime_test_reschedule__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      // A shared database can have other due tasks (other tests, other
      // merchants) claimed in the same batch — find this test's own
      // task by id rather than assuming it's returned first.
      const claimedTask = (await claimDueTasks(1000)).find((t) => t.id === id);
      expect(claimedTask).toBeDefined();
      expect(claimedTask!.attemptCount).toBe(1);

      const future = new Date(Date.now() + 60 * 60 * 1000);
      await rescheduleTask(id, future);

      const [task] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id));
      expect(task.status).toBe("waiting");
      expect(task.attemptCount).toBe(1); // unchanged by rescheduleTask itself
      expect(task.claimedUntil).toBeNull();

      const claimAttempt = await claimDueTasks(10);
      expect(claimAttempt.find((t) => t.id === id)).toBeUndefined(); // not due yet
    });

    it("attemptCount never exceeds maxAttempts across repeated claim/reschedule cycles — claiming is the one place it increments, and abandonTask is terminal", async () => {
      const merchant = await createTestMerchant("__runtime_test_ceiling__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 2 });
      taskIds.push(id);

      // Find our own task by id — a shared database can have other due
      // tasks claimed in the same batch.
      const firstClaim = (await claimDueTasks(1000)).find((t) => t.id === id);
      expect(firstClaim).toBeDefined();
      expect(firstClaim!.attemptCount).toBe(1);
      // runAfter is compared against the DATABASE's own now() in
      // claimDueTasks, never the app server's clock — a runAfter set
      // from new Date() here can race the DB's clock and not read as
      // due yet on an immediately-following claim. This is a REAL,
      // measured gap against this project's Neon instance (~500ms of
      // clock skew plus round-trip latency, confirmed directly against
      // now() while writing this test — consistent with FAILURES.md's
      // own documented ~1.1s cold-connection latency for this same
      // database), not a hypothetical worth rounding away. 10 seconds
      // is a real, comfortable margin against that measured gap.
      await rescheduleTask(id, new Date(Date.now() - 10_000));

      const secondClaim = (await claimDueTasks(1000)).find((t) => t.id === id);
      expect(secondClaim).toBeDefined();
      expect(secondClaim!.attemptCount).toBe(2);
      await abandonTask(id, merchant.id, "ceiling reached", "task_max_attempts_reached");

      const [task] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id));
      expect(task.status).toBe("failed");
      expect(task.attemptCount).toBeLessThanOrEqual(task.maxAttempts);

      // A terminal task never transitions again via reschedule/claim.
      const claimAttempt = await claimDueTasks(10);
      expect(claimAttempt.find((t) => t.id === id)).toBeUndefined();
    });

    it("cancelTask: a merchant-cancelled task is terminal and audited; cancelling twice throws", async () => {
      const merchant = await createTestMerchant("__runtime_test_cancel__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      await cancelTask(merchant.id, id);
      const [task] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id));
      expect(task.status).toBe("cancelled");

      await expect(cancelTask(merchant.id, id)).rejects.toThrow(/terminal status/);

      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
      expect(audit.some((a) => a.event === "agent_task_cancelled")).toBe(true);
    });

    it("retryTask: only a failed task can be retried, and it resets attemptCount", async () => {
      const merchant = await createTestMerchant("__runtime_test_retry__");
      merchantId = merchant.id;
      const agent = await makeAgent(merchant.id);

      const { id } = await createTask({ merchantId: merchant.id, agentId: agent.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      taskIds.push(id);

      await expect(retryTask(merchant.id, id)).rejects.toThrow(/only a failed task/);

      await abandonTask(id, merchant.id, "stopped", "some_rule");
      await retryTask(merchant.id, id);

      const [task] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id));
      expect(task.status).toBe("pending");
      expect(task.attemptCount).toBe(0);

      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
      expect(audit.some((a) => a.event === "agent_task_retried")).toBe(true);
    });
  });

  describe("merchant isolation", () => {
    it("listTasksForMerchant never returns another merchant's tasks, proven by id enumeration", async () => {
      const merchantA = await createTestMerchant("__runtime_test_iso_a__");
      const merchantB = await createTestMerchant("__runtime_test_iso_b__");
      const agentA = await makeAgent(merchantA.id);
      const agentB = await makeAgent(merchantB.id);

      const taskA = await createTask({ merchantId: merchantA.id, agentId: agentA.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });
      const taskB = await createTask({ merchantId: merchantB.id, agentId: agentB.id, kind: "recovery_sequence", state: { failureId: fakeFailureId() }, maxAttempts: 3 });

      const listA = await listTasksForMerchant(merchantA.id);
      expect(listA.some((t) => t.id === taskA.id)).toBe(true);
      expect(listA.some((t) => t.id === taskB.id)).toBe(false);

      await db.delete(schema.agentTasks).where(eq(schema.agentTasks.id, taskA.id));
      await db.delete(schema.agentTasks).where(eq(schema.agentTasks.id, taskB.id));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantA.id));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantB.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantA.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    });
  });

  describe("parseTaskState", () => {
    it("round-trips a valid recovery_sequence state", () => {
      const failureId = fakeFailureId();
      const parsed = parseTaskState("recovery_sequence", { failureId });
      expect(parsed.failureId).toBe(failureId);
    });

    it("throws on a malformed state rather than silently accepting it", () => {
      expect(() => parseTaskState("recovery_sequence", { failureId: "not-a-uuid" })).toThrow();
      expect(() => parseTaskState("recovery_sequence", {})).toThrow();
    });
  });
});
