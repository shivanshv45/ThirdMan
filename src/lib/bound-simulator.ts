import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkCapArithmetic } from "@/lib/gate";

/**
 * Layer 25-1: the Bound Simulator. "If your cap had been ₹X instead of
 * ₹Y over the last N days, M more purchases would have been allowed."
 *
 * The governing constraint (plans/layer-25-control-surfaces.md): this is
 * REPLAY of real recorded attempts against a hypothetical bound, never a
 * forecast. A denied buyer might have retried, bought less, or left —
 * pretending to know which is fabrication, so this module never
 * estimates revenue or demand, only what the deterministic arithmetic
 * itself would have output for each real attempt that already happened.
 *
 * It calls gate.ts's own checkCapArithmetic — the exact function
 * checkBounds runs on the real money path — never a second
 * reimplementation of the cap rules. See that function's docstring.
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_ATTEMPTS = 2000;

export interface SimulatedAttempt {
  auditLogId: string;
  createdAt: Date;
  amountPaise: number;
  /** What actually happened to this attempt, read off the real audit_log row. */
  actualDecision: "allow" | "deny" | "escalate";
  actualBoundApplied: string | null;
  /** Whether the ORIGINAL denial was specifically a cap bound (per_transaction_max or spend_cap_balance) — only these are ever "recoverable" by raising the cap. */
  wasCapDenial: boolean;
  /** What the hypothetical cap, applied in sequence, would have decided for this attempt. */
  hypotheticalDecision: "allow" | "deny";
  hypotheticalReason: string;
}

export interface BoundSimulationResult {
  agentId: string;
  windowDays: number;
  actualCapPaise: number | null;
  actualPerTransactionMaxPaise: number | null;
  hypotheticalCapPaise: number;
  hypotheticalPerTransactionMaxPaise: number;
  attemptsReplayed: number;
  /** Attempts that were genuinely denied by a CAP bound (not guardian, not escalation, not price mismatch) and would have been allowed under the hypothetical cap. */
  recoveredCount: number;
  recoveredAmountPaise: number;
  /** Attempts that were denied by a cap bound and would STILL be denied under the hypothetical cap — the hypothetical number wasn't the real constraint, or sequential consumption already used up the larger cap by then. */
  stillDeniedCount: number;
  /** Non-cap refusals (guardian, escalation, price mismatch, stock, etc.) — named explicitly so the report never claims a different bound's refusal as "recovered." */
  nonCapRefusalCount: number;
  attempts: SimulatedAttempt[];
}

/**
 * Every real money_action_attempt:* audit_log row for this agent in the
 * window, oldest first — the exact sequence the real gate consumed
 * budget in. Bounded window and MAX_ATTEMPTS cap so a merchant with a
 * long history never triggers an unbounded scan (per the plan).
 */
async function loadRealAttempts(agentId: string, windowDays: number) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: schema.auditLog.id,
      createdAt: schema.auditLog.createdAt,
      decision: schema.auditLog.decision,
      boundApplied: schema.auditLog.boundApplied,
      metadata: schema.auditLog.metadata,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actor, "agent"),
        gte(schema.auditLog.createdAt, since),
        sql`${schema.auditLog.event} like 'money_action_attempt:%'`,
        sql`${schema.auditLog.metadata}->>'agentId' = ${agentId}`,
      ),
    )
    .orderBy(asc(schema.auditLog.createdAt))
    .limit(MAX_ATTEMPTS);

  return rows;
}

function isCapBound(boundApplied: string | null): boolean {
  if (!boundApplied) return false;
  return boundApplied.startsWith("per_transaction_max:") || boundApplied.startsWith("spend_cap_balance:");
}

/**
 * Replays every real attempt in order against a hypothetical cap,
 * tracking hypothetical cumulative spend exactly as reserveBudget's own
 * running total does on the real path. Ordering matters: a larger cap
 * changes what's available for every SUBSEQUENT attempt in the window,
 * so this must simulate the sequence, not independently re-check each
 * attempt against the full hypothetical cap in isolation (the naive,
 * wrong answer the plan warns about by name).
 *
 * Only an attempt whose ORIGINAL denial was a cap bound is ever counted
 * as "recovered" — an attempt that was denied for a different reason
 * (guardian state, escalation, price mismatch, stock) would still have
 * been refused for that same reason regardless of the cap, so it is
 * reported separately and never folded into the recovered count.
 */
export async function simulateBoundChange(
  agentId: string,
  hypotheticalCapPaise: number,
  hypotheticalPerTransactionMaxPaise: number,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<BoundSimulationResult> {
  if (!Number.isInteger(hypotheticalCapPaise) || hypotheticalCapPaise <= 0) {
    throw new Error("hypotheticalCapPaise must be a positive integer number of paise");
  }
  if (!Number.isInteger(hypotheticalPerTransactionMaxPaise) || hypotheticalPerTransactionMaxPaise <= 0) {
    throw new Error("hypotheticalPerTransactionMaxPaise must be a positive integer number of paise");
  }

  const [cap] = await db
    .select({ id: schema.spendCaps.id, capPaise: schema.spendCaps.capPaise, perTransactionMaxPaise: schema.spendCaps.perTransactionMaxPaise })
    .from(schema.spendCaps)
    .where(eq(schema.spendCaps.agentId, agentId))
    .orderBy(sql`${schema.spendCaps.createdAt} desc`)
    .limit(1);

  const realRows = await loadRealAttempts(agentId, windowDays);

  // A synthetic id so checkCapArithmetic's boundApplied string is
  // well-formed even though this cap never existed as a real row.
  const hypotheticalCapId = "simulated";
  let hypotheticalSpentPaise = 0;

  const attempts: SimulatedAttempt[] = [];
  let recoveredCount = 0;
  let recoveredAmountPaise = 0;
  let stillDeniedCount = 0;
  let nonCapRefusalCount = 0;

  for (const row of realRows) {
    const metadata = (row.metadata ?? {}) as { amountPaise?: unknown };
    const amountPaise = typeof metadata.amountPaise === "number" ? metadata.amountPaise : null;
    // A recorded attempt with no numeric amount can't be replayed as
    // arithmetic — skip rather than fabricate a number.
    if (amountPaise === null) continue;

    const actualDecision: "allow" | "deny" | "escalate" = row.decision === "escalate" ? "escalate" : row.decision === "deny" ? "deny" : "allow";
    const wasCapDenial = actualDecision === "deny" && isCapBound(row.boundApplied);

    const failure = checkCapArithmetic(amountPaise, {
      id: hypotheticalCapId,
      capPaise: hypotheticalCapPaise,
      spentPaise: hypotheticalSpentPaise,
      perTransactionMaxPaise: hypotheticalPerTransactionMaxPaise,
    });

    let hypotheticalDecision: "allow" | "deny";
    let hypotheticalReason: string;

    if (failure) {
      hypotheticalDecision = "deny";
      hypotheticalReason = failure.reason;
    } else {
      hypotheticalDecision = "allow";
      hypotheticalReason = `Allowed — within the hypothetical ₹${(hypotheticalCapPaise / 100).toFixed(2)} cap and ₹${(hypotheticalPerTransactionMaxPaise / 100).toFixed(2)} per-transaction limit.`;
      // Only an attempt that would ACTUALLY have consumed budget on the
      // real path (allow or escalate — both reserve budget; a pure cap
      // deny never did) advances the hypothetical running total. A cap
      // denial that becomes hypothetically allowed also now consumes
      // budget going forward, which is exactly the sequential effect
      // the plan requires: recovering an earlier denial changes what's
      // available for every attempt after it.
      hypotheticalSpentPaise += amountPaise;
    }

    if (wasCapDenial) {
      if (hypotheticalDecision === "allow") {
        recoveredCount++;
        recoveredAmountPaise += amountPaise;
      } else {
        stillDeniedCount++;
      }
    } else if (actualDecision === "deny" || actualDecision === "escalate") {
      // A non-cap refusal or a deferral to the merchant — would still
      // have happened under the hypothetical cap for the same reason,
      // never counted as recovered.
      nonCapRefusalCount++;
    }

    attempts.push({
      auditLogId: row.id,
      createdAt: row.createdAt,
      amountPaise,
      actualDecision,
      actualBoundApplied: row.boundApplied,
      wasCapDenial,
      hypotheticalDecision,
      hypotheticalReason,
    });
  }

  return {
    agentId,
    windowDays,
    actualCapPaise: cap?.capPaise ?? null,
    actualPerTransactionMaxPaise: cap?.perTransactionMaxPaise ?? null,
    hypotheticalCapPaise,
    hypotheticalPerTransactionMaxPaise,
    attemptsReplayed: attempts.length,
    recoveredCount,
    recoveredAmountPaise,
    stillDeniedCount,
    nonCapRefusalCount,
    attempts,
  };
}
