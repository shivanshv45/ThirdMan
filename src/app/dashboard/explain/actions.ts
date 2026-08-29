"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { getDecisionById } from "@/lib/explainability";
import { explainDecision, type DecisionExplanation } from "@/lib/explain-decision";
import { getDecisionWaterfall, type WaterfallStep } from "@/lib/dashboard";

/**
 * Explains one decision on demand — never eagerly for a whole page of
 * rows, so opening /dashboard/explain never triggers 30-50 model calls.
 * Re-derives the decision from the real source tables by id rather than
 * trusting anything the client sends, and re-checks merchant ownership
 * on every call (getDecisionById is merchant-scoped) so a merchant can
 * never explain another merchant's decision by guessing an id.
 */
export async function explainDecisionAction(decisionId: string): Promise<DecisionExplanation & { notFound?: boolean }> {
  const merchant = await requireSessionMerchant();

  const decision = await getDecisionById(merchant.id, decisionId);
  if (!decision) {
    return { explanation: "", available: false, notFound: true };
  }

  return explainDecision(decision);
}

/**
 * Layer 15-2: the per-decision timing waterfall, fetched on demand from
 * the same "Show details" disclosure as the plain-language explainer —
 * never eagerly for a whole page of rows. moneyActionId re-checked
 * against this merchant inside getDecisionWaterfall itself, so a
 * merchant can't read another merchant's timing by guessing an id.
 */
export async function getDecisionWaterfallAction(moneyActionId: string): Promise<WaterfallStep[]> {
  const merchant = await requireSessionMerchant();
  return getDecisionWaterfall(merchant.id, moneyActionId);
}
