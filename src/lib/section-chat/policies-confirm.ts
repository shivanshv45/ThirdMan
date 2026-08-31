import * as mutations from "@/lib/dashboard-mutations";
import { policiesProposalSchema, type PoliciesProposal } from "./policies-schema";

/**
 * The Policies section chat bar's write-facing half. Calls the exact
 * same mutations.setMerchantPolicy the manual form's setMerchantPolicy
 * Server Action calls. No import of the LLM wrapper or
 * policies-draft.ts, see section-chat/policies.isolation.test.ts.
 */

export async function confirmPoliciesAction(
  merchantId: string,
  proposal: PoliciesProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = policiesProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "set_policy") {
      const {
        returnsAccepted,
        returnWindowDays,
        refundMethod,
        restockingFeePercent,
        shippingRegions,
        handlingTimeDays,
        warrantyMonths,
        policyNotes,
      } = parsed.data;
      await mutations.setMerchantPolicy({
        merchantId,
        returnsAccepted,
        returnWindowDays,
        refundMethod,
        restockingFeePercent,
        shippingRegions,
        handlingTimeDays,
        warrantyMonths,
        policyNotes,
      });
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not run that action." };
  }
}
