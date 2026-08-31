"use client";

import { SectionChatBar } from "@/components/ui";
import { draftTreasuryChatAction, confirmTreasuryChatAction } from "./actions";
import type { TreasuryProposal } from "@/lib/section-chat/treasury-schema";

export function TreasuryChatBar() {
  return (
    <SectionChatBar<TreasuryProposal>
      placeholder='Try "give buyers 2x rewards on orders over 1000 rupees"'
      onDraft={draftTreasuryChatAction}
      onConfirm={confirmTreasuryChatAction}
      renderProposal={(proposal) => {
        if (proposal.kind === "set_treasury_settings") {
          return (
            <p>
              Split: buyer {proposal.buyerPercent}% / merchant {proposal.merchantPercent}% / reserve {proposal.reservePercent}%
              {proposal.enabled ? "" : " (disabled)"}
            </p>
          );
        }
        if (proposal.kind === "create_reward_rule") {
          return (
            <p>
              {proposal.field} {proposal.operator} {proposal.value} → {proposal.multiplierX}x rewards
            </p>
          );
        }
        if (proposal.kind === "set_model_budget") {
          return (
            <p>
              {proposal.useCase.replace(/_/g, " ")} budget: ₹{proposal.budgetRupees}/month
            </p>
          );
        }
        if (proposal.kind === "no_action") {
          return <p>{proposal.summary}</p>;
        }
        return null;
      }}
    />
  );
}
