"use client";

import { SectionChatBar } from "@/components/ui";
import { draftPoliciesChatAction, confirmPoliciesChatAction } from "./actions";
import type { PoliciesProposal } from "@/lib/section-chat/policies-schema";

export function PoliciesChatBar() {
  return (
    <SectionChatBar<PoliciesProposal>
      placeholder='Try "accept returns for 30 days, refund to original payment method"'
      onDraft={draftPoliciesChatAction}
      onConfirm={confirmPoliciesChatAction}
      renderProposal={(proposal) =>
        proposal.kind === "set_policy" ? (
          <div>
            <p>Returns: {proposal.returnsAccepted ? `accepted, ${proposal.returnWindowDays ?? "?"} day window` : "not accepted"}</p>
            {proposal.refundMethod && <p>Refund via {proposal.refundMethod.replace(/_/g, " ")}</p>}
            {proposal.shippingRegions.length > 0 && <p>Ships to {proposal.shippingRegions.join(", ")}</p>}
          </div>
        ) : proposal.kind === "no_action" ? (
          <p>{proposal.summary}</p>
        ) : null
      }
    />
  );
}
