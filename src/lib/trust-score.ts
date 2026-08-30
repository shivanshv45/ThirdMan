import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Layer 25-3: the Trust Score. "Which of these agents can I trust?"
 * answered from evidence this codebase already owns — completed
 * purchases, refusal ratio, Guardian trips, negotiation behaviour,
 * account age — assembled into one integer with a visible, named
 * breakdown, mirroring agent-readiness.ts's exact shape: named weighted
 * checks, no model, no opaque weighting.
 *
 * THE RULE THIS FILE MUST NEVER BREAK: this is a read-layer figure. It
 * informs a merchant. It is never imported by gate.ts, never read by
 * checkBounds, never influences an allow/deny/escalate decision. See
 * trust-score-never-influences-gate.test.ts, which proves this both
 * structurally (gate.ts has no import of this module) and behaviourally
 * (an identical purchase produces a byte-identical decision regardless
 * of the agent's trust score) — the same proof pattern Layer 18 applied
 * to memory and Layer 25-3 itself requires per the plan.
 */

const MIN_EVIDENCE_TRANSACTIONS = 3;

export interface TrustComponent {
  id: string;
  label: string;
  weight: number;
  /** 0-1: how much of this component's weight was earned. Never a raw model score — always a named ratio over real counts. */
  score: number;
  detail: string;
}

export interface TrustReport {
  agentId: string;
  /** Integer 0-100. Weighted sum of components, only where evidence is present — see thinEvidence. */
  score: number;
  components: TrustComponent[];
  /** True when there are too few completed transactions to make the score meaningful — shown honestly rather than a confident-looking figure from nothing, matching agent-readiness.ts's own thin-evidence handling. */
  thinEvidence: boolean;
  completedPurchaseCount: number;
}

interface TrustInputs {
  completedPurchaseCount: number;
  totalAttemptCount: number;
  deniedAttemptCount: number;
  guardianSuspensionCount: number;
  negotiationsAgreedOrRedeemed: number;
  negotiationsExhausted: number;
  accountAgeDays: number;
}

const ACCOUNT_AGE_FULL_CREDIT_DAYS = 30;

/**
 * Pure scoring over already-loaded counts — no I/O, directly unit
 * testable, same split agent-readiness.ts's computeReadiness uses.
 */
export function computeTrustScore(inputs: TrustInputs): TrustReport {
  const thinEvidence = inputs.completedPurchaseCount < MIN_EVIDENCE_TRANSACTIONS;

  const refusalRatio = inputs.totalAttemptCount > 0 ? inputs.deniedAttemptCount / inputs.totalAttemptCount : 0;
  const negotiationTotal = inputs.negotiationsAgreedOrRedeemed + inputs.negotiationsExhausted;

  const components: TrustComponent[] = [
    {
      id: "track_record",
      label: "Completed purchase history",
      weight: 40,
      // Saturates at 20 completed purchases — a long history earns full
      // credit without needing an arbitrarily higher bar.
      score: Math.min(inputs.completedPurchaseCount / 20, 1),
      detail: `${inputs.completedPurchaseCount} completed purchase${inputs.completedPurchaseCount === 1 ? "" : "s"}.`,
    },
    {
      id: "refusal_ratio",
      label: "Low refusal rate",
      weight: 25,
      score: inputs.totalAttemptCount > 0 ? 1 - refusalRatio : 0.5,
      detail:
        inputs.totalAttemptCount > 0
          ? `${(refusalRatio * 100).toFixed(0)}% of ${inputs.totalAttemptCount} attempt(s) were denied.`
          : "No recorded attempts yet.",
    },
    {
      id: "guardian_clean",
      label: "No Guardian suspensions",
      weight: 20,
      // Any real suspension is a genuine incident — one halves this
      // component, two or more zeroes it. Never a soft decay for a
      // real breach the Guardian itself already treats as terminal
      // until a merchant re-arms it.
      score: inputs.guardianSuspensionCount === 0 ? 1 : inputs.guardianSuspensionCount === 1 ? 0.5 : 0,
      detail:
        inputs.guardianSuspensionCount === 0
          ? "Never suspended by the Runtime Guardian."
          : `Suspended by the Runtime Guardian ${inputs.guardianSuspensionCount} time(s).`,
    },
    {
      id: "negotiation_behaviour",
      label: "Negotiates in good faith",
      weight: 10,
      score: negotiationTotal > 0 ? inputs.negotiationsAgreedOrRedeemed / negotiationTotal : 0.5,
      detail:
        negotiationTotal > 0
          ? `${inputs.negotiationsAgreedOrRedeemed} of ${negotiationTotal} negotiation(s) reached agreement.`
          : "No negotiations attempted.",
    },
    {
      id: "account_age",
      label: "Account age",
      weight: 5,
      score: Math.min(inputs.accountAgeDays / ACCOUNT_AGE_FULL_CREDIT_DAYS, 1),
      detail: `${inputs.accountAgeDays} day(s) since this agent was created.`,
    },
  ];

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = components.reduce((sum, c) => sum + c.weight * c.score, 0);
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

  return {
    agentId: "",
    score,
    components,
    thinEvidence,
    completedPurchaseCount: inputs.completedPurchaseCount,
  };
}

const COMPLETED_STATUSES = ["executed", "held", "captured"] as const;

/** Loads real data and computes the report — the only place this module touches the DB. */
export async function getTrustScore(merchantId: string, agentId: string): Promise<TrustReport> {
  const [agent] = await db
    .select({ createdAt: schema.agents.createdAt })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchantId)));
  if (!agent) throw new Error("Agent not found");

  const [completedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.agentId, agentId), inArray(schema.moneyActions.status, COMPLETED_STATUSES)));

  const [attemptRow] = await db.execute<{ total: string; denied: string }>(sql`
    select
      count(*) filter (where event like 'money_action_attempt:%') as total,
      count(*) filter (where event like 'money_action_attempt:%' and decision = 'deny') as denied
    from ${schema.auditLog}
    where merchant_id = ${merchantId} and metadata->>'agentId' = ${agentId}
  `);

  const [guardianRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.guardianTransitions)
    .where(and(eq(schema.guardianTransitions.agentId, agentId), eq(schema.guardianTransitions.toState, "suspended")));

  const [negotiationRow] = await db.execute<{ agreed: string; exhausted: string }>(sql`
    select
      count(*) filter (where status in ('agreed', 'redeemed')) as agreed,
      count(*) filter (where status = 'refused_turns_exhausted') as exhausted
    from ${schema.negotiations}
    where agent_id = ${agentId}
  `);

  const accountAgeDays = Math.max(0, Math.floor((Date.now() - agent.createdAt.getTime()) / (24 * 60 * 60 * 1000)));

  const report = computeTrustScore({
    completedPurchaseCount: completedRow?.count ?? 0,
    totalAttemptCount: Number(attemptRow?.total ?? 0),
    deniedAttemptCount: Number(attemptRow?.denied ?? 0),
    guardianSuspensionCount: guardianRow?.count ?? 0,
    negotiationsAgreedOrRedeemed: Number(negotiationRow?.agreed ?? 0),
    negotiationsExhausted: Number(negotiationRow?.exhausted ?? 0),
    accountAgeDays,
  });

  return { ...report, agentId };
}
