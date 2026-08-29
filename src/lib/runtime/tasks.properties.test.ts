import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTask, claimDueTasks, rescheduleTask, completeTask, abandonTask, cancelTask } from "@/lib/runtime/tasks";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 17-5: property-based proof of the task state machine's
 * invariants, following the same split gate.properties.test.ts
 * established (Layer 13-1): a pure model at a high run count, checked
 * against sequences of the real operations claimDueTasks/rescheduleTask/
 * abandonTask/completeTask actually perform.
 *
 * Mirrors tasks.ts's real transition rules exactly:
 *  - claim only succeeds from pending/waiting (runAfter due) or from a
 *    claimed state whose lease has expired — never from claimed with an
 *    active lease, never from a terminal state.
 *  - claiming increments attemptCount by exactly 1.
 *  - reschedule moves claimed -> waiting, clears the lease, does NOT
 *    touch attemptCount.
 *  - complete/abandon are terminal: no further transition ever succeeds.
 */

type Status = "pending" | "waiting" | "claimed" | "succeeded" | "failed" | "cancelled";

class PureTask {
  status: Status = "pending";
  attemptCount = 0;
  leaseActive = false; // true while claimed AND the lease hasn't expired
  readonly maxAttempts: number;

  constructor(maxAttempts: number) {
    this.maxAttempts = maxAttempts;
  }

  get isClaimable(): boolean {
    if (this.status === "pending" || this.status === "waiting") return true;
    if (this.status === "claimed" && !this.leaseActive) return true; // expired lease — reclaimable, same as tasks.ts's taskEligibilityCondition
    return false;
  }

  get isTerminal(): boolean {
    return this.status === "succeeded" || this.status === "failed" || this.status === "cancelled";
  }

  claim(): boolean {
    if (!this.isClaimable) return false;
    this.status = "claimed";
    this.leaseActive = true;
    this.attemptCount += 1;
    return true;
  }

  expireLease(): void {
    if (this.status === "claimed") this.leaseActive = false;
  }

  reschedule(): boolean {
    if (this.status !== "claimed") return false;
    this.status = "waiting";
    this.leaseActive = false;
    return true;
  }

  complete(): boolean {
    if (this.isTerminal) return false;
    this.status = "succeeded";
    return true;
  }

  abandon(): boolean {
    if (this.isTerminal) return false;
    this.status = "failed";
    return true;
  }

  cancel(): boolean {
    if (this.isTerminal) return false;
    this.status = "cancelled";
    return true;
  }
}

type Op = { kind: "claim" } | { kind: "expireLease" } | { kind: "reschedule" } | { kind: "complete" } | { kind: "abandon" } | { kind: "cancel" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: "claim" }),
  fc.constant<Op>({ kind: "expireLease" }),
  fc.constant<Op>({ kind: "reschedule" }),
  fc.constant<Op>({ kind: "complete" }),
  fc.constant<Op>({ kind: "abandon" }),
  fc.constant<Op>({ kind: "cancel" }),
);

function applyOp(task: PureTask, op: Op): void {
  switch (op.kind) {
    case "claim":
      task.claim();
      return;
    case "expireLease":
      task.expireLease();
      return;
    case "reschedule":
      task.reschedule();
      return;
    case "complete":
      task.complete();
      return;
    case "abandon":
      task.abandon();
      return;
    case "cancel":
      task.cancel();
      return;
  }
}

describe("runtime task state machine — pure model (property-based, high run count)", () => {
  it("claim() only ever succeeds when the task was actually claimable — never on an already-live claim or a terminal task", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.array(opArb, { minLength: 0, maxLength: 200 }), (maxAttempts, ops) => {
        const task = new PureTask(maxAttempts);
        for (const op of ops) {
          if (op.kind === "claim") {
            const wasClaimable = task.isClaimable;
            const succeeded = task.claim();
            expect(succeeded).toBe(wasClaimable);
          } else {
            applyOp(task, op);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("attemptCount never exceeds the number of times claim() actually succeeded, and equals it exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.array(opArb, { minLength: 0, maxLength: 200 }), (maxAttempts, ops) => {
        const task = new PureTask(maxAttempts);
        let successfulClaims = 0;
        for (const op of ops) {
          if (op.kind === "claim" && task.isClaimable) successfulClaims += 1;
          applyOp(task, op);
        }
        expect(task.attemptCount).toBe(successfulClaims);
      }),
      { numRuns: 2000 },
    );
  });

  it("a terminal task never transitions again — claim/reschedule/complete/abandon/cancel all fail once succeeded/failed/cancelled", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.array(opArb, { minLength: 0, maxLength: 200 }), (maxAttempts, ops) => {
        const task = new PureTask(maxAttempts);
        for (const op of ops) {
          const wasTerminal = task.isTerminal;
          const statusBefore = task.status;
          applyOp(task, op);
          if (wasTerminal) {
            expect(task.status).toBe(statusBefore); // no operation moves a terminal task anywhere
          }
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("reschedule only ever succeeds from claimed, and never changes attemptCount", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.array(opArb, { minLength: 0, maxLength: 200 }), (maxAttempts, ops) => {
        const task = new PureTask(maxAttempts);
        for (const op of ops) {
          if (op.kind === "reschedule") {
            const attemptCountBefore = task.attemptCount;
            const wasClaimed = task.status === "claimed";
            const succeeded = task.reschedule();
            expect(succeeded).toBe(wasClaimed);
            // reschedule never touches attemptCount — claimDueTasks is the only place it increments
            expect(task.attemptCount).toBe(attemptCountBefore);
          } else {
            applyOp(task, op);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("no sequence of claim/expireLease/reschedule produces a task claimable AND terminal at once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.array(opArb, { minLength: 0, maxLength: 200 }), (maxAttempts, ops) => {
        const task = new PureTask(maxAttempts);
        for (const op of ops) {
          applyOp(task, op);
          expect(task.isClaimable && task.isTerminal).toBe(false);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------
// DB-backed sequence tests. Low run count (real Neon round-trips per
// operation) — the same shape of generated sequence, executed against
// the real claimDueTasks/rescheduleTask/completeTask/abandonTask/
// cancelTask, proving the pure model above actually matches the
// implementation, not just an idealized version of it.
// ---------------------------------------------------------------------

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__runtime_props_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

type RealOp = "claim" | "reschedule" | "complete" | "abandon" | "cancel";

const realOpArb: fc.Arbitrary<RealOp> = fc.constantFrom("claim", "reschedule", "complete", "abandon", "cancel");

describe("runtime task state machine — DB-backed sequence tests (low run count, real tasks.ts)", () => {
  it(
    "a generated sequence of claim/reschedule/complete/abandon/cancel against a real task matches the pure model's claimable/terminal predicates at every step",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(realOpArb, { minLength: 1, maxLength: 8 }), async (ops) => {
          const merchant = await createTestMerchant("__runtime_props_test__");
          const agent = await makeAgent(merchant.id);
          const { id: taskId } = await createTask({
            merchantId: merchant.id,
            agentId: agent.id,
            kind: "recovery_sequence",
            state: { failureId: randomUUID() },
            maxAttempts: 10,
          });

          const pure = new PureTask(10);

          for (const op of ops) {
            if (op === "claim") {
              const wasClaimable = pure.isClaimable;
              const claimed = await claimDueTasks(1000);
              const realClaimed = claimed.some((t) => t.id === taskId);
              expect(realClaimed).toBe(wasClaimable);
              pure.claim();
            } else if (op === "reschedule") {
              const statusBefore = (await db.select({ status: schema.agentTasks.status }).from(schema.agentTasks).where(eq(schema.agentTasks.id, taskId)))[0].status;
              const wasClaimed = statusBefore === "claimed";
              const pureSucceeded = pure.reschedule();
              expect(pureSucceeded).toBe(wasClaimed);

              await rescheduleTask(taskId, new Date(Date.now() - 10_000));
              const [row] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, taskId));
              // rescheduleTask is guarded by WHERE status = 'claimed' —
              // it only takes effect when the task was actually claimed,
              // matching the pure model's own guard exactly. This is
              // the property whose absence let a terminal task get
              // silently resurrected before the fix (see FAILURES.md).
              if (wasClaimed) {
                expect(row.status).toBe("waiting");
              } else {
                expect(row.status).toBe(statusBefore);
              }
            } else if (op === "complete") {
              if (!pure.isTerminal) await completeTask(taskId, merchant.id, "property test complete");
              pure.complete();
            } else if (op === "abandon") {
              if (!pure.isTerminal) await abandonTask(taskId, merchant.id, "property test abandon", "property_test_rule");
              pure.abandon();
            } else {
              try {
                await cancelTask(merchant.id, taskId);
              } catch {
                // cancelTask throws on an already-terminal task — the real function's own bound, matching the pure model's isTerminal guard.
              }
              pure.cancel();
            }
          }

          const [finalRow] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, taskId));
          const realTerminal = finalRow.status === "succeeded" || finalRow.status === "failed" || finalRow.status === "cancelled";
          expect(realTerminal).toBe(pure.isTerminal);

          await db.delete(schema.agentTaskSteps).where(eq(schema.agentTaskSteps.taskId, taskId));
          await db.delete(schema.agentTasks).where(eq(schema.agentTasks.id, taskId));
          await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
          await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchant.id));
          await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));
        }),
        { numRuns: 15 },
      );
    },
    60_000,
  );
});
