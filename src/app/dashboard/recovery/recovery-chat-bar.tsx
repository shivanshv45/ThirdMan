"use client";

import { SectionChatBar } from "@/components/ui";
import { draftRecoveryChatAction, confirmRecoveryChatAction } from "./actions";
import type { RecoveryProposal } from "@/lib/section-chat/recovery-schema";

export function RecoveryChatBar() {
  return (
    <SectionChatBar<RecoveryProposal>
      placeholder='Try "load a demo batch" or "run recovery on everything pending"'
      onDraft={draftRecoveryChatAction}
      onConfirm={confirmRecoveryChatAction}
      renderProposal={(proposal) => <p>{proposal.summary}</p>}
    />
  );
}
