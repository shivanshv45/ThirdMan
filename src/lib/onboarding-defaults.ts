import { createAgent, setSpendCap, setAgentCapabilities, setMerchantPolicy } from "@/lib/dashboard-mutations";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 24-10: a new merchant's dashboard is empty and that's where
 * onboarding dies (the plan's own framing). This seeds real, ordinary
 * rows through the exact same mutation functions a merchant's own
 * clicks would call — never a fabricated metric or a fake transaction
 * (EmptyState's no-fake-rows discipline is about not inventing
 * HISTORY; a real default configuration the merchant can see and
 * change is not that).
 *
 * Every value here is deliberately conservative and named as a default
 * in both the agent's own name and the audit trail, so a merchant who
 * never touches this is never confused about where it came from.
 */

const DEFAULT_AGENT_NAME = "Starter agent (default)";
const DEFAULT_CAP_RUPEES = 2_000; // ₹2,000 total — enough to demo a real purchase, small enough to bound a mistake
const DEFAULT_PER_TRANSACTION_MAX_RUPEES = 500; // ₹500 per transaction
const DEFAULT_WINDOW_HOURS = 24 * 30; // 30 days

export interface OnboardingDefaultsResult {
  agentId: string;
  agentApiKey: string;
}

/**
 * Called once, right after a merchant account is created. Idempotent by
 * construction in the sense that matters here: it is only ever invoked
 * from the signup path, which itself only runs once per merchant — not
 * re-run on every login, so no re-entrancy guard is needed the way
 * setSpendCap's own revoke-then-create pattern needs one for repeat calls.
 */
export async function seedOnboardingDefaults(merchantId: string): Promise<OnboardingDefaultsResult> {
  const { agent, rawKey } = await createAgent(merchantId, DEFAULT_AGENT_NAME);

  await setSpendCap({
    merchantId,
    agentId: agent.id,
    capRupees: DEFAULT_CAP_RUPEES,
    perTransactionMaxRupees: DEFAULT_PER_TRANSACTION_MAX_RUPEES,
    windowHours: DEFAULT_WINDOW_HOURS,
  });

  // The minimum capability set for an agent to do anything demonstrable
  // at all — read the catalogue and policy, and buy. Never
  // negotiation:create or rewards:redeem by default; those are a
  // merchant's own explicit choice to grant.
  await setAgentCapabilities(merchantId, agent.id, ["products:read", "policy:read", "purchase:create"]);

  await setMerchantPolicy({
    merchantId,
    returnsAccepted: true,
    returnWindowDays: 7,
    refundMethod: "original_payment_method",
    restockingFeePercent: null,
    shippingRegions: ["IN"],
    handlingTimeDays: 2,
    warrantyMonths: null,
    policyNotes: "This is a starting policy — review and adjust it in Policies before you rely on it.",
  });

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "onboarding_defaults_seeded",
    decision: "n/a",
    reason: `New merchant account seeded with a starter agent (₹${DEFAULT_CAP_RUPEES} cap, ₹${DEFAULT_PER_TRANSACTION_MAX_RUPEES} per transaction) and a default 7-day return policy — every value is a real row visible on the dashboard, clearly labelled as a default to review, not a fabricated metric.`,
    metadata: { agentId: agent.id },
  });

  return { agentId: agent.id, agentApiKey: rawKey };
}
