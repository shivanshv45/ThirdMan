"use server";

import { revalidatePath } from "next/cache";
import * as mutations from "@/lib/dashboard-mutations";
import { resolveEscalation } from "@/lib/gate";
import { requireSessionMerchant, destroySession } from "@/lib/auth";
import { getAuditTrail } from "@/lib/dashboard";
import { redirect } from "next/navigation";

export type AuditEntry = Awaited<ReturnType<typeof getAuditTrail>>[number];

/** Re-fetches the audit trail for the client-side Refresh button, without a full page reload. */
export async function refreshAuditTrail(): Promise<AuditEntry[]> {
  const merchant = await requireSessionMerchant();
  return getAuditTrail(merchant.id, 100);
}

/**
 * Thin Server Action wrappers: resolve the session merchant, parse
 * FormData, delegate to the framework-agnostic logic in
 * dashboard-mutations.ts or the gate, then revalidate. Keeping these
 * thin is what makes the actual mutation logic testable without a
 * Next.js request context. Every action re-derives the merchant from
 * the session rather than trusting a client-supplied merchantId.
 */

export async function setSpendCap(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.setSpendCap({
    merchantId: merchant.id,
    agentId: String(formData.get("agentId")),
    capRupees: Number(formData.get("capRupees")),
    perTransactionMaxRupees: Number(formData.get("perTransactionMaxRupees")),
    windowHours: Number(formData.get("windowHours")),
  });
  revalidatePath("/dashboard");
}

export type AgentKeyActionState =
  | { rawKey: string; agentName: string; error?: undefined }
  | { rawKey?: undefined; agentName?: undefined; error: string }
  | null;

export async function createAgentAction(
  _prevState: AgentKeyActionState,
  formData: FormData,
): Promise<AgentKeyActionState> {
  const merchant = await requireSessionMerchant();
  const name = String(formData.get("name") ?? "");

  try {
    const { agent, rawKey } = await mutations.createAgent(merchant.id, name);
    revalidatePath("/dashboard");
    return { rawKey, agentName: agent.name };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create agent." };
  }
}

export async function rotateAgentKeyAction(
  _prevState: AgentKeyActionState,
  formData: FormData,
): Promise<AgentKeyActionState> {
  const merchant = await requireSessionMerchant();
  const agentId = String(formData.get("agentId") ?? "");

  try {
    const { agent, rawKey } = await mutations.rotateAgentKey(merchant.id, agentId);
    revalidatePath("/dashboard");
    return { rawKey, agentName: agent.name };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not rotate key." };
  }
}

export async function revokeAgent(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.revokeAgent(merchant.id, String(formData.get("agentId")));
  revalidatePath("/dashboard");
}

export async function reactivateAgent(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.reactivateAgent(merchant.id, String(formData.get("agentId")));
  revalidatePath("/dashboard");
}

export async function approveEscalation(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const escalationId = String(formData.get("escalationId"));
  if (!escalationId) throw new Error("Missing escalationId");
  await resolveEscalation(merchant.id, escalationId, "approved");
  revalidatePath("/dashboard");
}

export async function rejectEscalation(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const escalationId = String(formData.get("escalationId"));
  if (!escalationId) throw new Error("Missing escalationId");
  await resolveEscalation(merchant.id, escalationId, "rejected");
  revalidatePath("/dashboard");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
