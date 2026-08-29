import { sql, eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 13-4: the Runtime Guardian. Supervision — is this agent behaving
 * normally RIGHT NOW — computed entirely from tables this codebase
 * already owns (money_actions, audit_log, ai_credit_redemptions). No new
 * telemetry source, no model consulted: "is this anomalous" is
 * arithmetic against a rolling baseline, never a judgment call. See
 * CLAUDE.md rule 2.
 *
 * Baselines are computed in SQL via percentile_cont, not a mean+stddev —
 * one outlier destroys a mean/stddev threshold, and doing the percentile
 * computation in Postgres keeps it where the data already is.
 *
 * The Guardian is a BOUND, not a passive observer: a suspended/revoked
 * agent causes checkBounds to deny outright (see gate.ts's
 * resolveGuardianBound). Evaluated inline on the money path (cheap
 * indexed queries) and swept periodically via /api/cron/run.
 */

export type GuardianState = (typeof schema.guardianStateEnum.enumValues)[number];

// The rolling window a baseline is computed over, and the window a
// "right now" signal is measured over. Kept separate and named, not
// magic numbers scattered through the SQL below.
const BASELINE_WINDOW_DAYS = 14;
const RECENT_WINDOW_MINUTES = 15;

// Deterministic constants, documented next to their definition per the
// plan. Each threshold is a MULTIPLE of the agent's own rolling
// baseline (or an absolute floor when the baseline itself is thin), so
// a naturally busy agent isn't punished for its own normal volume.
const VELOCITY_MULTIPLIER = 4; // transactions in the recent window vs. the per-15-min baseline
const DENIED_RATIO_THRESHOLD = 0.6; // fraction of recent attempts that were denied/failed
const DENIED_RATIO_MIN_SAMPLE = 5; // don't judge a ratio off fewer than this many attempts
const RETRY_SAME_TARGET_THRESHOLD = 5; // identical amountPaise+context repeated in the recent window
const ESCALATION_RATE_THRESHOLD = 0.5;
const ESCALATION_RATE_MIN_SAMPLE = 4;
const AI_SPEND_RATE_MULTIPLIER = 5; // AI-credit redemptions in the recent window vs. the daily baseline's per-15-min share

export interface GuardianSignals {
  recentTransactionCount: number;
  velocityBaseline: number;
  deniedRatio: number;
  deniedSampleSize: number;
  maxRetrySameTarget: number;
  escalationRate: number;
  escalationSampleSize: number;
  recentAiCreditRedemptions: number;
  aiSpendBaseline: number;
}

export interface GuardianEvaluation {
  breached: boolean;
  signal: string;
  observedValue: string;
  baselineValue: string;
  reason: string;
}

/**
 * All five signals from plans/layer-13-authorization-supervision-proof.md's
 * L13-4, computed via SQL window functions / percentile_cont over the
 * prior BASELINE_WINDOW_DAYS, plus the current RECENT_WINDOW_MINUTES
 * count to compare against. One round trip per signal, all read-only.
 */
export async function computeGuardianSignals(agentId: string): Promise<GuardianSignals> {
  // Passed into raw sql`` as ISO strings, not Date objects — postgres-js
  // mis-binds a Date parameter mixed with a uuid-typed parameter in the
  // same statement (a real bug this file's own test suite caught: a
  // "string argument must be... Received an instance of Date" error).
  // Casting the column with ::timestamptz keeps the comparison correct;
  // drizzle's query-builder helpers (gte/lte, used elsewhere in this
  // codebase) don't hit this because they never pass a raw Date into a
  // hand-written sql`` template. See FAILURES.md.
  const recentSince = new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const baselineSince = new Date(Date.now() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Velocity: recent transaction count vs. the median transactions-per-
  // 15-minute-bucket baseline over the trailing window.
  const [recentCountRow] = await db.execute<{ count: string }>(
    sql`select count(*) as count from ${schema.moneyActions} where agent_id = ${agentId} and created_at >= ${recentSince}::timestamptz`,
  );
  const [velocityBaselineRow] = await db.execute<{ baseline_median: string | null }>(sql`
    select percentile_cont(0.5) within group (order by bucket_count) as baseline_median
    from (
      select count(*) as bucket_count
      from ${schema.moneyActions}
      where agent_id = ${agentId} and created_at >= ${baselineSince}::timestamptz
      group by date_trunc('minute', created_at) - (extract(minute from created_at)::int % 15) * interval '1 minute'
    ) buckets
  `);
  const velocityRow = { recent_count: recentCountRow?.count ?? "0", baseline_median: velocityBaselineRow?.baseline_median ?? null };

  // Denied ratio in the recent window — how many of this agent's recent
  // attempts (allowed OR denied, read from audit_log so a pure-deny
  // attempt that never got a money_actions row still counts) were denied.
  const [deniedRow] = await db.execute<{ total: string; denied: string }>(sql`
    select
      count(*) filter (where event like 'money_action_attempt:%') as total,
      count(*) filter (where event like 'money_action_attempt:%' and decision = 'deny') as denied
    from ${schema.auditLog}
    where merchant_id = (select merchant_id from ${schema.agents} where id = ${agentId})
      and metadata->>'agentId' = ${agentId}
      and created_at >= ${recentSince}::timestamptz
  `);

  // Retry against the same target: the largest count of money_actions
  // sharing the same (amountPaise, variantId) pair in the recent window
  // — a real retry-loop signature, not just "many transactions."
  const [retryRow] = await db.execute<{ max_repeat: string | null }>(sql`
    select max(cnt) as max_repeat from (
      select count(*) as cnt
      from ${schema.moneyActions}
      where agent_id = ${agentId} and created_at >= ${recentSince}::timestamptz
      group by amount_paise, variant_id
    ) grouped
  `);

  // Escalation rate: fraction of recent money_actions that landed in
  // pending_escalation.
  const [escalationRow] = await db.execute<{ total: string; escalated: string }>(sql`
    select
      count(*) as total,
      count(*) filter (where status = 'pending_escalation') as escalated
    from ${schema.moneyActions}
    where agent_id = ${agentId} and created_at >= ${recentSince}::timestamptz
  `);

  // AI spend rate (Layer 11-8): recent ai_credit_redemptions vs. a
  // baseline share of the trailing window, same bucketed-median shape as
  // velocity above.
  const [aiRecentCountRow] = await db.execute<{ count: string }>(
    sql`select count(*) as count from ${schema.aiCreditRedemptions} where agent_id = ${agentId} and created_at >= ${recentSince}::timestamptz`,
  );
  const [aiSpendBaselineRow] = await db.execute<{ baseline_median: string | null }>(sql`
    select percentile_cont(0.5) within group (order by bucket_count) as baseline_median
    from (
      select count(*) as bucket_count
      from ${schema.aiCreditRedemptions}
      where agent_id = ${agentId} and created_at >= ${baselineSince}::timestamptz
      group by date_trunc('minute', created_at) - (extract(minute from created_at)::int % 15) * interval '1 minute'
    ) buckets
  `);
  const aiSpendRow = { recent_count: aiRecentCountRow?.count ?? "0", baseline_median: aiSpendBaselineRow?.baseline_median ?? null };

  const deniedTotal = Number(deniedRow?.total ?? 0);
  const escalationTotal = Number(escalationRow?.total ?? 0);

  return {
    recentTransactionCount: Number(velocityRow?.recent_count ?? 0),
    velocityBaseline: Number(velocityRow?.baseline_median ?? 0),
    deniedRatio: deniedTotal > 0 ? Number(deniedRow!.denied) / deniedTotal : 0,
    deniedSampleSize: deniedTotal,
    maxRetrySameTarget: Number(retryRow?.max_repeat ?? 0),
    escalationRate: escalationTotal > 0 ? Number(escalationRow!.escalated) / escalationTotal : 0,
    escalationSampleSize: escalationTotal,
    recentAiCreditRedemptions: Number(aiSpendRow?.recent_count ?? 0),
    aiSpendBaseline: Number(aiSpendRow?.baseline_median ?? 0),
  };
}

/**
 * Pure evaluation of signals against the thresholds above — no I/O, so
 * this is directly unit-testable. Returns the FIRST breach found (in a
 * fixed, documented order), since a transition needs exactly one
 * trigger to name, not all of them at once. Absence of a breach returns
 * breached: false.
 */
export function evaluateGuardianSignals(signals: GuardianSignals): GuardianEvaluation {
  // Velocity: only meaningful once there's a real baseline to compare
  // against (a brand-new agent's first burst isn't "4x its baseline" —
  // it has no baseline yet) — an absolute floor covers that case instead.
  const velocityFloor = Math.max(signals.velocityBaseline * VELOCITY_MULTIPLIER, 20);
  if (signals.recentTransactionCount > velocityFloor) {
    return {
      breached: true,
      signal: "transaction_velocity",
      observedValue: String(signals.recentTransactionCount),
      baselineValue: signals.velocityBaseline.toFixed(1),
      reason: `${signals.recentTransactionCount} transactions in the last ${RECENT_WINDOW_MINUTES} minutes, against a baseline of ${signals.velocityBaseline.toFixed(1)} per ${RECENT_WINDOW_MINUTES}-minute window.`,
    };
  }

  if (signals.deniedSampleSize >= DENIED_RATIO_MIN_SAMPLE && signals.deniedRatio > DENIED_RATIO_THRESHOLD) {
    return {
      breached: true,
      signal: "denied_ratio",
      observedValue: `${(signals.deniedRatio * 100).toFixed(0)}%`,
      baselineValue: `${(DENIED_RATIO_THRESHOLD * 100).toFixed(0)}%`,
      reason: `${(signals.deniedRatio * 100).toFixed(0)}% of the last ${signals.deniedSampleSize} attempts were denied, above the ${(DENIED_RATIO_THRESHOLD * 100).toFixed(0)}% threshold.`,
    };
  }

  if (signals.maxRetrySameTarget > RETRY_SAME_TARGET_THRESHOLD) {
    return {
      breached: true,
      signal: "retry_count",
      observedValue: String(signals.maxRetrySameTarget),
      baselineValue: String(RETRY_SAME_TARGET_THRESHOLD),
      reason: `The same amount/variant was attempted ${signals.maxRetrySameTarget} times in the last ${RECENT_WINDOW_MINUTES} minutes, above the ${RETRY_SAME_TARGET_THRESHOLD}-attempt threshold.`,
    };
  }

  if (signals.escalationSampleSize >= ESCALATION_RATE_MIN_SAMPLE && signals.escalationRate > ESCALATION_RATE_THRESHOLD) {
    return {
      breached: true,
      signal: "escalation_rate",
      observedValue: `${(signals.escalationRate * 100).toFixed(0)}%`,
      baselineValue: `${(ESCALATION_RATE_THRESHOLD * 100).toFixed(0)}%`,
      reason: `${(signals.escalationRate * 100).toFixed(0)}% of the last ${signals.escalationSampleSize} purchases were escalated, above the ${(ESCALATION_RATE_THRESHOLD * 100).toFixed(0)}% threshold.`,
    };
  }

  const aiSpendFloor = Math.max(signals.aiSpendBaseline * AI_SPEND_RATE_MULTIPLIER, 20);
  if (signals.recentAiCreditRedemptions > aiSpendFloor) {
    return {
      breached: true,
      signal: "ai_spend_rate",
      observedValue: String(signals.recentAiCreditRedemptions),
      baselineValue: signals.aiSpendBaseline.toFixed(1),
      reason: `${signals.recentAiCreditRedemptions} AI-credit redemptions in the last ${RECENT_WINDOW_MINUTES} minutes, against a baseline of ${signals.aiSpendBaseline.toFixed(1)} per ${RECENT_WINDOW_MINUTES}-minute window.`,
    };
  }

  return { breached: false, signal: "", observedValue: "", baselineValue: "", reason: "" };
}

/** The current Guardian state for an agent, defaulting to "normal" with no row yet — created lazily, same discipline as merchant_policies' "absence is real." */
export async function getGuardianState(agentId: string): Promise<GuardianState> {
  const [row] = await db.select({ state: schema.agentGuardianState.state }).from(schema.agentGuardianState).where(eq(schema.agentGuardianState.agentId, agentId));
  return row?.state ?? "normal";
}

const NEXT_STATE_ON_BREACH: Record<GuardianState, GuardianState> = {
  normal: "throttled",
  throttled: "suspended",
  suspended: "suspended",
  revoked: "revoked",
};

/**
 * Evaluates one agent's signals and, if a breach is found, advances its
 * state one step (normal -> throttled -> suspended; suspended stays
 * suspended until a merchant re-arms it explicitly). Writes a
 * guardian_transitions row and an audit entry naming the exact signal
 * and values on every transition — never a bare "suspended." A clean
 * evaluation with no breach is a no-op: it does not reset an already
 * elevated state, since only an explicit merchant re-arm may do that
 * (fail closed — silence is not an improvement).
 */
export async function evaluateAndTransition(agentId: string): Promise<{ state: GuardianState; transitioned: boolean; evaluation: GuardianEvaluation }> {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) throw new Error(`No agent found with id ${agentId}`);

  const currentState = await getGuardianState(agentId);
  const signals = await computeGuardianSignals(agentId);
  const evaluation = evaluateGuardianSignals(signals);

  if (!evaluation.breached) {
    return { state: currentState, transitioned: false, evaluation };
  }

  const nextState = NEXT_STATE_ON_BREACH[currentState];
  if (nextState === currentState) {
    // Already at the terminal breached state (suspended/revoked) —
    // record nothing new, a merchant already has an open incident to act on.
    return { state: currentState, transitioned: false, evaluation };
  }

  await db
    .insert(schema.agentGuardianState)
    .values({
      agentId,
      state: nextState,
      lastSignal: evaluation.signal,
      lastObservedValue: evaluation.observedValue,
      lastBaselineValue: evaluation.baselineValue,
    })
    .onConflictDoUpdate({
      target: schema.agentGuardianState.agentId,
      set: { state: nextState, lastSignal: evaluation.signal, lastObservedValue: evaluation.observedValue, lastBaselineValue: evaluation.baselineValue, updatedAt: new Date() },
    });

  await db.insert(schema.guardianTransitions).values({
    agentId,
    fromState: currentState,
    toState: nextState,
    triggerSignal: evaluation.signal,
    observedValue: evaluation.observedValue,
    baselineValue: evaluation.baselineValue,
  });

  await logAuditEntry({
    merchantId: agent.merchantId,
    actor: "system",
    event: "guardian_transition",
    decision: nextState === "suspended" ? "deny" : "n/a",
    reason: `Agent "${agent.name}" moved ${currentState} -> ${nextState}: ${evaluation.reason}`,
    boundApplied: `guardian:${evaluation.signal}`,
    metadata: { agentId, fromState: currentState, toState: nextState, signal: evaluation.signal },
  });

  return { state: nextState, transitioned: true, evaluation };
}

/**
 * Merchant re-arm: the only path back to "normal" from throttled or
 * suspended. Explicit and human, never automatic — a Guardian that
 * quietly resets itself once volume calms down would let exactly the
 * pattern it caught keep happening on a duty cycle.
 */
export async function rearmAgent(merchantId: string, agentId: string): Promise<void> {
  const [agent] = await db.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchantId)));
  if (!agent) throw new Error("Agent not found");

  const currentState = await getGuardianState(agentId);
  if (currentState === "normal") return;

  await db
    .insert(schema.agentGuardianState)
    .values({ agentId, state: "normal", lastSignal: "merchant_rearm", lastObservedValue: null, lastBaselineValue: null })
    .onConflictDoUpdate({
      target: schema.agentGuardianState.agentId,
      set: { state: "normal", lastSignal: "merchant_rearm", lastObservedValue: null, lastBaselineValue: null, updatedAt: new Date() },
    });

  await db.insert(schema.guardianTransitions).values({
    agentId,
    fromState: currentState,
    toState: "normal",
    triggerSignal: "merchant_rearm",
    observedValue: "n/a",
    baselineValue: null,
  });

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "guardian_rearm",
    decision: "n/a",
    reason: `Merchant re-armed agent "${agent.name}" — Guardian state reset from ${currentState} to normal.`,
    metadata: { agentId, fromState: currentState },
  });
}

/**
 * Periodic sweep across every active agent — registered in
 * /api/cron/run alongside every other Layer 11 job, so an agent that
 * only makes one suspicious burst and then goes quiet is still caught
 * even though evaluateAndTransition also runs inline on the money path.
 */
export async function sweepAllAgents(): Promise<{ agentsEvaluated: number; transitions: number }> {
  const activeAgents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.status, "active"));

  let transitions = 0;
  for (const { id } of activeAgents) {
    try {
      const result = await evaluateAndTransition(id);
      if (result.transitioned) transitions++;
    } catch (err) {
      console.error(`[guardian] sweep failed for agent ${id}:`, err);
    }
  }

  return { agentsEvaluated: activeAgents.length, transitions };
}
