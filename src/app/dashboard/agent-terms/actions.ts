"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setMerchantAgentTerms } from "@/lib/agent-terms";
import { requireSessionMerchant } from "@/lib/auth";
import { rupeesToPaise } from "@/lib/money";
import { schema } from "@/lib/db";
import { draftAgentTermsAction, type ChatTurn } from "@/lib/section-chat/agent-terms-draft";
import { confirmAgentTermsAction } from "@/lib/section-chat/agent-terms-confirm";
import type { AgentTermsProposal } from "@/lib/section-chat/agent-terms-schema";

type AgentCapability = (typeof schema.agentCapabilityEnum.enumValues)[number];

export async function draftAgentTermsChatAction(history: ChatTurn[]) {
  const merchant = await requireSessionMerchant();
  return draftAgentTermsAction(merchant.id, history);
}

export async function confirmAgentTermsChatAction(proposal: AgentTermsProposal) {
  const merchant = await requireSessionMerchant();
  const result = await confirmAgentTermsAction(merchant.id, proposal);
  if (result.ok) revalidatePath("/dashboard/agent-terms");
  return result;
}

/**
 * One form is the whole truth, same shape as setMerchantPolicy/
 * setAgentCapabilities. Rupee inputs are converted at this boundary —
 * agent-terms.ts operates on paise only, per CLAUDE.md's money rule. An
 * empty numeric field means "no ceiling configured" (null), never zero.
 */
export async function setAgentTerms(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const parseOptionalRupees = (key: string): number | null => {
    const raw = formData.get(key);
    if (raw === null || raw === "") return null;
    return rupeesToPaise(Number(raw));
  };

  try {
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: formData.get("unknownAgentsAllowed") === "on",
      newAgentOrderCeilingPaise: parseOptionalRupees("newAgentOrderCeilingRupees"),
      mandateRequiredAbovePaise: parseOptionalRupees("mandateRequiredAboveRupees"),
      negotiationOpenToAgents: formData.get("negotiationOpenToAgents") === "on",
      selfRegisterDefaultCapabilities: formData.getAll("selfRegisterDefaultCapabilities").map(String) as AgentCapability[],
      selfRegistrationOpen: formData.get("selfRegistrationOpen") === "on",
      selfRegisterStartingCapPaise: parseOptionalRupees("selfRegisterStartingCapRupees"),
      selfRegisterPerTransactionMaxPaise: parseOptionalRupees("selfRegisterPerTransactionMaxRupees"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save agent terms.";
    redirect(`/dashboard/agent-terms?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/agent-terms");
}
