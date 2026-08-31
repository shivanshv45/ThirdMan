"use client";

import { SectionChatBar } from "@/components/ui";
import { draftNegotiationsChatAction, confirmNegotiationsChatAction } from "./actions";
import type { NegotiationsProposal } from "@/lib/section-chat/negotiations-schema";

export function NegotiationsChatBar() {
  return (
    <SectionChatBar<NegotiationsProposal>
      placeholder='Try "set the floor for SKU DARK-500 to 380 rupees"'
      onDraft={draftNegotiationsChatAction}
      onConfirm={confirmNegotiationsChatAction}
      renderProposal={(proposal) =>
        proposal.kind === "set_floor" ? (
          <p>
            SKU {proposal.sku}: {proposal.floorPriceRupees === null ? "clear floor (not negotiable)" : `floor ₹${proposal.floorPriceRupees}`}
          </p>
        ) : proposal.kind === "no_action" ? (
          <p>{proposal.summary}</p>
        ) : null
      }
    />
  );
}
