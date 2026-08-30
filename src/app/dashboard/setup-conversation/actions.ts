"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { draftSetupProposal } from "@/lib/setup-conversation";
import { createProposedAgents, type CreatedAgentSummary } from "@/lib/setup-conversation-confirm";
import type { SetupProposal } from "@/lib/setup-conversation-schema";

/**
 * Thin Server Action wrappers, same split every other dashboard mutation
 * uses. Both actions return state directly rather than redirecting —
 * useActionState drives the client component, matching agent-key-reveal.tsx's
 * "show a freshly generated key exactly once" shape, which this page
 * also needs (createProposedAgents returns a raw key per created agent).
 */

export type DraftState = { ok: true; proposal: SetupProposal } | { ok: false; reason: string } | null;

export async function draftSetupAction(_prev: DraftState, formData: FormData): Promise<DraftState> {
  const merchant = await requireSessionMerchant();
  const instruction = String(formData.get("instruction") ?? "");
  return draftSetupProposal(merchant.id, instruction);
}

export type ConfirmState = { ok: true; created: CreatedAgentSummary[] } | { ok: false; reason: string } | null;

export async function confirmSetupAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const merchant = await requireSessionMerchant();
  const proposalJson = String(formData.get("proposalJson") ?? "");

  let proposal: unknown;
  try {
    proposal = JSON.parse(proposalJson);
  } catch {
    return { ok: false, reason: "Could not read the proposal — please draft it again." };
  }

  return createProposedAgents(merchant.id, proposal);
}
