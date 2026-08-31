import { setMerchantAgentTerms } from "@/lib/agent-terms";
import { rupeesToPaise } from "@/lib/money";
import { agentTermsProposalSchema, type AgentTermsProposal } from "./agent-terms-schema";

/**
 * The Agent terms section chat bar's write-facing half. Calls the
 * exact same setMerchantAgentTerms the manual form's setAgentTerms
 * Server Action calls. No import of the LLM wrapper or
 * agent-terms-draft.ts, see section-chat/agent-terms.isolation.test.ts.
 */

export async function confirmAgentTermsAction(
  merchantId: string,
  proposal: AgentTermsProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = agentTermsProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "set_terms") {
      const {
        unknownAgentsAllowed,
        newAgentOrderCeilingRupees,
        mandateRequiredAboveRupees,
        negotiationOpenToAgents,
        selfRegisterDefaultCapabilities,
        selfRegistrationOpen,
        selfRegisterStartingCapRupees,
        selfRegisterPerTransactionMaxRupees,
      } = parsed.data;

      await setMerchantAgentTerms({
        merchantId,
        unknownAgentsAllowed,
        newAgentOrderCeilingPaise: newAgentOrderCeilingRupees === null ? null : rupeesToPaise(newAgentOrderCeilingRupees),
        mandateRequiredAbovePaise: mandateRequiredAboveRupees === null ? null : rupeesToPaise(mandateRequiredAboveRupees),
        negotiationOpenToAgents,
        selfRegisterDefaultCapabilities,
        selfRegistrationOpen,
        selfRegisterStartingCapPaise: selfRegisterStartingCapRupees === null ? null : rupeesToPaise(selfRegisterStartingCapRupees),
        selfRegisterPerTransactionMaxPaise: selfRegisterPerTransactionMaxRupees === null ? null : rupeesToPaise(selfRegisterPerTransactionMaxRupees),
      });
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not run that action." };
  }
}
