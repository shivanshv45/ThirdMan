import { and, desc, eq, gte } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { completeStructured } from "@/lib/llm";
import { z } from "zod";

/**
 * The judgment layer inside the gate, run only after every deterministic
 * bound check has already passed. It can downgrade an allow to an
 * escalate. It can never turn a deny into an allow, and it can never
 * turn an allow into anything worse than escalate, since attemptMoneyAction
 * only calls this once bounds are already satisfied.
 *
 * The signals below are computed in plain code, not by a model. See
 * CLAUDE.md, "AI decides judgment. Code decides limits."
 */

export interface RiskSignals {
  /** What fraction of the cap's total this single request would consume, 0 to 1. */
  fractionOfCap: number;
  /** How many requests this agent made in the last 5 minutes. */
  recentRequestCount: number;
  /** Whether this exact amount was requested by this agent in the last 5 minutes. */
  isRepeatedAmount: boolean;
}

export interface RiskAssessment {
  decision: "allow" | "escalate";
  reason: string;
  /** Which path produced the decision, for the audit trail. */
  source: "model" | "deterministic_fallback";
}

const RECENT_WINDOW_MS = 5 * 60 * 1000;

// If the model is unavailable, escalate above this fraction of the cap
// rather than guessing. A model outage must never open the gate wider
// than it would otherwise be.
const FALLBACK_ESCALATION_THRESHOLD = 0.5;

export async function computeRiskSignals(
  agentId: string,
  amountPaise: number,
  cap: { capPaise: number },
): Promise<RiskSignals> {
  const since = new Date(Date.now() - RECENT_WINDOW_MS);

  const recentActions = await db
    .select({ amountPaise: schema.moneyActions.amountPaise })
    .from(schema.moneyActions)
    .where(
      and(
        eq(schema.moneyActions.agentId, agentId),
        gte(schema.moneyActions.createdAt, since),
      ),
    )
    .orderBy(desc(schema.moneyActions.createdAt));

  return {
    fractionOfCap: cap.capPaise > 0 ? amountPaise / cap.capPaise : 1,
    recentRequestCount: recentActions.length,
    isRepeatedAmount: recentActions.some((a) => a.amountPaise === amountPaise),
  };
}

const riskResponseSchema = z.object({
  decision: z.enum(["allow", "escalate"]),
  reason: z.string().min(1),
});

/**
 * The fixed threshold rule used when the model is unavailable. Pure and
 * deterministic, so it's directly testable without needing to force a
 * real model failure. A model outage must never open the gate wider
 * than this rule would.
 */
export function deterministicFallback(signals: RiskSignals): RiskAssessment {
  if (signals.fractionOfCap > FALLBACK_ESCALATION_THRESHOLD) {
    return {
      decision: "escalate",
      reason: `Model unavailable. Deterministic fallback: this request consumes ${(signals.fractionOfCap * 100).toFixed(0)}% of the cap, above the ${(FALLBACK_ESCALATION_THRESHOLD * 100).toFixed(0)}% fallback threshold.`,
      source: "deterministic_fallback",
    };
  }

  return {
    decision: "allow",
    reason: `Model unavailable. Deterministic fallback: this request consumes ${(signals.fractionOfCap * 100).toFixed(0)}% of the cap, within the ${(FALLBACK_ESCALATION_THRESHOLD * 100).toFixed(0)}% fallback threshold.`,
    source: "deterministic_fallback",
  };
}

/**
 * Given the deterministic signals and purchase context, asks the model
 * for a proceed/escalate recommendation with a plain-language rationale.
 * On any model failure, falls back to deterministicFallback instead of
 * retrying indefinitely or defaulting to allow.
 */
export async function assessRisk(
  signals: RiskSignals,
  context: string,
): Promise<RiskAssessment> {
  try {
    const result = await completeStructured({
      prompt: `A purchasing agent wants to make this purchase: "${context}".

Signals about this request:
- It would consume ${(signals.fractionOfCap * 100).toFixed(0)}% of the agent's total spend cap.
- The agent has made ${signals.recentRequestCount} requests in the last 5 minutes.
- This exact amount was ${signals.isRepeatedAmount ? "" : "NOT "}requested again recently.

This request has already passed all hard spend-cap checks. Your only job is to judge whether the PATTERN looks risky enough to hold for human review, not whether it fits the budget. Recommend "escalate" only for genuinely suspicious patterns (e.g. rapid repeated identical amounts, a request consuming most of the cap in one shot). Otherwise recommend "allow".`,
      schema: riskResponseSchema,
      schemaDescription: '{ "decision": "allow" | "escalate", "reason": "one sentence" }',
    });

    return {
      decision: result.data.decision,
      reason: result.data.reason,
      source: "model",
    };
  } catch (err) {
    console.warn("[risk] Model assessment failed, using deterministic fallback:", err);
    return deterministicFallback(signals);
  }
}
