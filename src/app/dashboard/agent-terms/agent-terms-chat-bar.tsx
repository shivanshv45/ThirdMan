"use client";

import { SectionChatBar } from "@/components/ui";
import { draftAgentTermsChatAction, confirmAgentTermsChatAction } from "./actions";
import type { AgentTermsProposal } from "@/lib/section-chat/agent-terms-schema";

export function AgentTermsChatBar() {
  return (
    <SectionChatBar<AgentTermsProposal>
      placeholder='Try "allow unknown agents up to 2000 rupees without a mandate"'
      onDraft={draftAgentTermsChatAction}
      onConfirm={confirmAgentTermsChatAction}
      renderProposal={(proposal) =>
        proposal.kind === "set_terms" ? (
          <div>
            <p>Unknown agents: {proposal.unknownAgentsAllowed ? "allowed" : "blocked"}</p>
            {proposal.newAgentOrderCeilingRupees !== null && <p>New-agent ceiling: ₹{proposal.newAgentOrderCeilingRupees}</p>}
            {proposal.mandateRequiredAboveRupees !== null && <p>Mandate required above: ₹{proposal.mandateRequiredAboveRupees}</p>}
            <p>Self-registration: {proposal.selfRegistrationOpen ? "open" : "closed"}</p>
          </div>
        ) : proposal.kind === "no_action" ? (
          <p>{proposal.summary}</p>
        ) : null
      }
    />
  );
}
