"use client";

import { useActionState, useState } from "react";
import { draftSetupAction, confirmSetupAction, type DraftState, type ConfirmState } from "./actions";
import { Surface, Button, Field, EmptyState } from "@/components/ui";

const draftInitial: DraftState = null;
const confirmInitial: ConfirmState = null;

/**
 * Two-step client flow, mirroring reward-rules.ts's draft → confirm
 * shape: draft renders a proposal for review, confirm is the only step
 * that ever creates a row. Holding the proposal in component state
 * between the two (rather than round-tripping through a redirect query
 * param the way treasury/actions.ts does) keeps a multi-agent proposal
 * — which can be a few KB of JSON — off the URL.
 */
export function SetupConversationFlow() {
  const [draftState, draftAction, draftPending] = useActionState(draftSetupAction, draftInitial);
  const [confirmState, confirmAction, confirmPending] = useActionState(confirmSetupAction, confirmInitial);
  const [dismissed, setDismissed] = useState(false);

  if (confirmState?.ok) {
    return <CreatedFleet created={confirmState.created} />;
  }

  if (draftState?.ok && !dismissed) {
    return (
      <ProposalReview
        proposal={draftState.proposal}
        onDiscard={() => setDismissed(true)}
        confirmAction={confirmAction}
        confirmPending={confirmPending}
        confirmError={confirmState && !confirmState.ok ? confirmState.reason : undefined}
      />
    );
  }

  return (
    <Surface variant="raised" className="p-6 space-y-4">
      <form action={draftAction} className="space-y-3">
        <Field label="What do you want?" help="Plain English is fine — the assistant only proposes; it never creates anything on its own.">
          <textarea
            name="instruction"
            required
            rows={3}
            placeholder="e.g. I need something to chase failed payments, and two that can talk to customers"
            className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink placeholder:text-on-ink-faint outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={draftPending} pendingLabel="Thinking…">
          Propose agents
        </Button>
        {draftState && !draftState.ok && <p className="text-sm text-deny-bright">{draftState.reason}</p>}
      </form>
      {!draftState && (
        <EmptyState
          title="No proposal yet"
          description="Describe what you want above. You'll see the exact name, cap, and capabilities for every proposed agent before anything is created."
        />
      )}
    </Surface>
  );
}

function ProposalReview({
  proposal,
  onDiscard,
  confirmAction,
  confirmPending,
  confirmError,
}: {
  proposal: import("@/lib/setup-conversation-schema").SetupProposal;
  onDiscard: () => void;
  confirmAction: (formData: FormData) => void;
  confirmPending: boolean;
  confirmError?: string;
}) {
  return (
    <div className="space-y-4">
      <Surface variant="inset" className="p-4">
        <p className="text-sm text-on-ink-dim">
          Nothing has been created yet. Review every agent below — you can discard this and describe it differently, or confirm to create all {proposal.agents.length} at once.
        </p>
      </Surface>

      <div className="space-y-3">
        {proposal.agents.map((agent, i) => (
          <Surface key={i} variant="raised" className="p-5 space-y-2">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h3 className="text-[var(--t-h4)] font-medium text-on-ink">{agent.name}</h3>
              <span className="text-xs text-on-ink-faint font-mono">
                ₹{agent.suggestedCapRupees.toLocaleString("en-IN")} cap · ₹{agent.suggestedPerTransactionMaxRupees.toLocaleString("en-IN")}/transaction
              </span>
            </div>
            <p className="text-sm text-on-ink-dim">{agent.purpose}</p>
            <p className="text-xs text-on-ink-faint">{agent.capReason}</p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {agent.capabilities.map((cap) => (
                <span key={cap} className="px-1.5 py-0.5 rounded text-xs font-mono bg-ink-overlay border border-ink-line text-on-ink-dim">
                  {cap}
                </span>
              ))}
            </div>
          </Surface>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <form action={confirmAction}>
          <input type="hidden" name="proposalJson" value={JSON.stringify(proposal)} />
          <Button type="submit" variant="primary" disabled={confirmPending} pendingLabel="Creating…">
            Confirm and create all {proposal.agents.length}
          </Button>
        </form>
        <Button type="button" variant="ghost" onClick={onDiscard}>
          Discard and try again
        </Button>
      </div>
      {confirmError && <p className="text-sm text-deny-bright">{confirmError}</p>}
    </div>
  );
}

function CreatedFleet({ created }: { created: { agentId: string; name: string; apiKey: string }[] }) {
  return (
    <div className="space-y-4">
      <Surface variant="raised" className="p-5">
        <p className="text-sm text-allow-bright font-medium">{created.length} agent{created.length === 1 ? "" : "s"} created.</p>
        <p className="text-xs text-on-ink-faint mt-1">
          Copy each key now — it will not be shown again. Manage caps and capabilities any time on Agents &amp; caps.
        </p>
      </Surface>
      <div className="space-y-2">
        {created.map((agent) => (
          <div key={agent.agentId} className="rounded-[var(--radius-lg)] border border-escalate-line bg-escalate-wash p-3 text-sm space-y-1.5">
            <p className="font-medium text-on-ink">{agent.name}</p>
            <p className="font-mono text-xs break-all bg-ink border border-ink-line rounded-[var(--radius)] px-2 py-1.5 text-on-ink">{agent.apiKey}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
