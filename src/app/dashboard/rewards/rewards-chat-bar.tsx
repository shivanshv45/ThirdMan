"use client";

import { SectionChatBar } from "@/components/ui";
import { draftRewardsChatAction, confirmRewardsChatAction } from "./actions";
import type { RewardsProposal } from "@/lib/section-chat/rewards-schema";

/**
 * The thin client wrapper SectionChatBar needs: this section's own
 * draft/confirm Server Actions and how to render its own proposal
 * shape. Kept out of the generic component so nothing about a specific
 * section's fields lives in shared UI code.
 */
export function RewardsChatBar() {
  return (
    <SectionChatBar<RewardsProposal>
      placeholder='Try "make coins worth 2 rupees each" or "add a tier for the 120B model at 15 coins"'
      onDraft={draftRewardsChatAction}
      onConfirm={confirmRewardsChatAction}
      renderProposal={(proposal) => {
        if (proposal.kind === "set_reward_settings") {
          return (
            <div>
              <p>{proposal.summary}</p>
              <dl className="grid grid-cols-3 gap-3 mt-2 text-xs">
                <div>
                  <dt className="text-on-ink-faint">Value per coin</dt>
                  <dd className="font-mono text-on-ink">₹{proposal.paisePerCoinRupees.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-on-ink-faint">Issue rate</dt>
                  <dd className="font-mono text-on-ink">{(proposal.issueRatePermille / 10).toFixed(1)}%</dd>
                </div>
                <div>
                  <dt className="text-on-ink-faint">Max redemption</dt>
                  <dd className="font-mono text-on-ink">{proposal.maxRedemptionPercent}%</dd>
                </div>
              </dl>
            </div>
          );
        }

        if (proposal.kind === "add_ai_credit_tier") {
          return (
            <div>
              <p>{proposal.summary}</p>
              <dl className="grid grid-cols-2 gap-3 mt-2 text-xs">
                <div>
                  <dt className="text-on-ink-faint">Model</dt>
                  <dd className="font-mono text-on-ink">{proposal.modelId}</dd>
                </div>
                <div>
                  <dt className="text-on-ink-faint">Coins per response</dt>
                  <dd className="font-mono text-on-ink">{proposal.coinsPerRequest}</dd>
                </div>
              </dl>
            </div>
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
