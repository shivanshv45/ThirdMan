import { eq, and, gte, inArray, desc, asc } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Read-only, merchant-scoped aggregation. No model call — this is pure
 * SQL over recovery_attempts.recovered_paise, the single source of truth
 * for what was actually recovered (see plans/layer-3-recovery-pipeline.md:
 * summing from money_actions too would give two numbers that can diverge,
 * and the divergence is the kind of thing that surfaces on stage).
 */

export interface RecoveryStats {
  totalFailedPaise: number;
  recoveredPaise: number;
  recoveryRatePercent: number;
  failureCount: number;
  recoveredCount: number;
  writtenOffCount: number;
  recoveringCount: number;
  attemptsMade: number;
  attemptsDeclined: number;
  stoppedByRule: Record<string, number>;
}

export async function getRecoveryStats(merchantId: string, since?: Date): Promise<RecoveryStats> {
  const failureConditions = since
    ? and(eq(schema.paymentFailures.merchantId, merchantId), gte(schema.paymentFailures.createdAt, since))
    : eq(schema.paymentFailures.merchantId, merchantId);

  const failures = await db.select().from(schema.paymentFailures).where(failureConditions);

  const totalFailedPaise = failures.reduce((sum, f) => sum + f.amountPaise, 0);
  const recoveredCount = failures.filter((f) => f.status === "recovered").length;
  const writtenOffCount = failures.filter((f) => f.status === "written_off").length;
  const recoveringCount = failures.filter((f) => f.status === "recovering").length;

  const failureIds = failures.map((f) => f.id);

  let recoveredPaise = 0;
  let attemptsMade = 0;
  let attemptsDeclined = 0;
  const stoppedByRule: Record<string, number> = {};

  if (failureIds.length > 0) {
    const attempts = await db
      .select()
      .from(schema.recoveryAttempts)
      .where(inArray(schema.recoveryAttempts.paymentFailureId, failureIds));

    for (const attempt of attempts) {
      if (attempt.outcome === "succeeded") {
        recoveredPaise += attempt.recoveredPaise;
      }
      if (attempt.strategy === "write_off" || attempt.outcome === "abandoned") {
        attemptsDeclined += 1;
      } else {
        attemptsMade += 1;
      }
    }

    // Stopping-rule breakdown comes from audit_log entries written at
    // stop time (event: "recovery_stopped"), since recovery_attempts
    // doesn't carry the rule name itself — boundApplied does.
    const stopEntries = await db
      .select({ boundApplied: schema.auditLog.boundApplied })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.merchantId, merchantId), eq(schema.auditLog.event, "recovery_stopped")));

    for (const entry of stopEntries) {
      const rule = entry.boundApplied ?? "unknown";
      stoppedByRule[rule] = (stoppedByRule[rule] ?? 0) + 1;
    }
  }

  const recoveryRatePercent = totalFailedPaise > 0 ? Math.round((recoveredPaise * 100) / totalFailedPaise) : 0;

  return {
    totalFailedPaise,
    recoveredPaise,
    recoveryRatePercent,
    failureCount: failures.length,
    recoveredCount,
    writtenOffCount,
    recoveringCount,
    attemptsMade,
    attemptsDeclined,
    stoppedByRule,
  };
}

export interface FailureWithAttempts {
  failure: typeof schema.paymentFailures.$inferSelect;
  attempts: (typeof schema.recoveryAttempts.$inferSelect)[];
}

export async function getFailureQueue(merchantId: string): Promise<FailureWithAttempts[]> {
  const failures = await db
    .select()
    .from(schema.paymentFailures)
    .where(eq(schema.paymentFailures.merchantId, merchantId))
    .orderBy(desc(schema.paymentFailures.createdAt));

  if (failures.length === 0) return [];

  // One query for every failure's attempts rather than one query per
  // failure — the previous version issued a query per row in the loop.
  const allAttempts = await db
    .select()
    .from(schema.recoveryAttempts)
    .where(inArray(schema.recoveryAttempts.paymentFailureId, failures.map((f) => f.id)))
    .orderBy(asc(schema.recoveryAttempts.attemptNumber));

  const attemptsByFailureId = new Map<string, (typeof schema.recoveryAttempts.$inferSelect)[]>();
  for (const attempt of allAttempts) {
    const list = attemptsByFailureId.get(attempt.paymentFailureId) ?? [];
    list.push(attempt);
    attemptsByFailureId.set(attempt.paymentFailureId, list);
  }

  return failures.map((failure) => ({
    failure,
    attempts: attemptsByFailureId.get(failure.id) ?? [],
  }));
}
