"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { createDecisionShareToken, getShareTokensForDecision } from "@/lib/decision-share";
import { issueRefusalReceipt } from "@/lib/refusal-receipt";
import { getDecisionById } from "@/lib/explainability";

/** Creates (or reuses an existing) shareable link for one decision this merchant owns. getDecisionById re-verifies ownership before any token is minted — a merchant can't share a decision by guessing another merchant's id. */
export async function createShareLinkAction(decisionId: string): Promise<{ token: string } | { error: string }> {
  const merchant = await requireSessionMerchant();

  const decision = await getDecisionById(merchant.id, decisionId);
  if (!decision) return { error: "Decision not found" };

  const existing = await getShareTokensForDecision(merchant.id, decisionId);
  if (existing.length > 0) return { token: existing[0].token };

  const token = await createDecisionShareToken(merchant.id, decisionId);
  return { token };
}

/**
 * Issues a Refusal Receipt for a decision already recorded — reusing
 * the same signer refusal-receipt.ts uses at decision time, over the
 * SAME audit_log row this page is already displaying. Available on
 * demand rather than eagerly, matching explainDecisionAction's own
 * on-demand shape.
 */
export async function issueReceiptForDecisionAction(merchantId: string, decisionId: string): Promise<{ receipt: string | undefined }> {
  const merchant = await requireSessionMerchant();
  if (merchant.id !== merchantId) return { receipt: undefined };

  const decision = await getDecisionById(merchant.id, decisionId);
  if (!decision) return { receipt: undefined };

  const receipt = await issueRefusalReceipt(merchant.id, {
    decision: decision.kind === "refusal" ? "deny" : "escalate",
    reason: decision.reason,
    moneyActionId: decision.sourceRef.moneyActionId,
  });

  return { receipt };
}
