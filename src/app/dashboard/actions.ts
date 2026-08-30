"use server";

import { revalidatePath } from "next/cache";
import * as mutations from "@/lib/dashboard-mutations";
import { resolveEscalation, attemptMoneyAction, type GateResult } from "@/lib/gate";
import { requireSessionMerchant, destroySession } from "@/lib/auth";
import { getAuditTrail } from "@/lib/dashboard";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { rearmAgent, freezeAllAgents, unfreezeAllAgents } from "@/lib/guardian";
import { cancelTask, retryTask } from "@/lib/runtime/tasks";
import { confirmStatedMemory } from "@/lib/memory/stated";
import { deleteMemory, correctMemory } from "@/lib/memory/retrieve";
import { getTrustScore, type TrustReport } from "@/lib/trust-score";
import { simulateBoundChange, type BoundSimulationResult } from "@/lib/bound-simulator";
import { approveReturnRequest, rejectReturnRequest } from "@/lib/returns-desk-decision";
import { redirect } from "next/navigation";

type AgentCapability = (typeof schema.agentCapabilityEnum.enumValues)[number];

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
  revalidatePath("/dashboard/agents");
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
    revalidatePath("/dashboard/agents");
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
    revalidatePath("/dashboard/agents");
    return { rawKey, agentName: agent.name };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not rotate key." };
  }
}

export async function setAgentCapabilities(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const agentId = String(formData.get("agentId"));
  const capabilities = formData.getAll("capabilities").map(String) as AgentCapability[];
  await mutations.setAgentCapabilities(merchant.id, agentId, capabilities);
  revalidatePath("/dashboard/agents");
}

export async function setAgentMandateRequired(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const agentId = String(formData.get("agentId"));
  const required = formData.get("mandateRequired") === "on";
  await mutations.setAgentMandateRequired(merchant.id, agentId, required);
  revalidatePath("/dashboard/agents");
}

export async function revokeAgent(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.revokeAgent(merchant.id, String(formData.get("agentId")));
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/agents");
}

export async function reactivateAgent(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.reactivateAgent(merchant.id, String(formData.get("agentId")));
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/agents");
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

/**
 * Layer 22 — the ONLY two entrypoints from the UI that can resolve a
 * return request. Both delegate to returns-desk-decision.ts, which is
 * itself the only module in this codebase that both reads a
 * return_requests row and calls gate.ts's issueRefund — the model's
 * conversation module (returns-desk.ts) has no path here at all. See
 * returns-desk.isolation.test.ts.
 */
export async function approveReturnRequestAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const returnRequestId = String(formData.get("returnRequestId"));
  if (!returnRequestId) throw new Error("Missing returnRequestId");
  const amountRupees = formData.get("amountRupees");
  const amountPaise = amountRupees && String(amountRupees).trim() ? Math.round(Number(amountRupees) * 100) : undefined;
  const result = await approveReturnRequest(merchant.id, returnRequestId, amountPaise);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/dashboard/returns");
}

export async function rejectReturnRequestAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const returnRequestId = String(formData.get("returnRequestId"));
  if (!returnRequestId) throw new Error("Missing returnRequestId");
  const reason = String(formData.get("reason") ?? "");
  const result = await rejectReturnRequest(merchant.id, returnRequestId, reason);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/dashboard/returns");
}

/**
 * Layer 13-5: the merchant-facing preflight simulator — calls the exact
 * same attemptMoneyAction({ dryRun: true }) an agent's own
 * /api/agent/preflight call would, so "what happens if this agent tries
 * ₹X" answers with the real gate, not a copy of its rules. Re-verifies
 * the agent belongs to this merchant before simulating anything against it.
 */
export async function runPreflightSimulation(formData: FormData): Promise<GateResult & { agentName: string }> {
  const merchant = await requireSessionMerchant();
  const agentId = String(formData.get("agentId"));
  const amountRupees = Number(formData.get("amountRupees"));
  const context = String(formData.get("context") ?? "Merchant-run preflight simulation");

  const [agent] = await db.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchant.id)));
  if (!agent) throw new Error("Agent not found");

  if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
    throw new Error("Enter a positive amount");
  }

  const result = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: merchant.id,
    type: "order_create",
    amountPaise: Math.round(amountRupees * 100),
    context,
    dryRun: true,
  });

  return { ...result, agentName: agent.name };
}

export async function rearmAgentAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const agentId = String(formData.get("agentId"));
  if (!agentId) throw new Error("Missing agentId");
  await rearmAgent(merchant.id, agentId);
  revalidatePath("/dashboard/guardian");
  revalidatePath("/dashboard/agents");
}

export async function cancelTaskAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const taskId = String(formData.get("taskId"));
  if (!taskId) throw new Error("Missing taskId");
  await cancelTask(merchant.id, taskId);
  revalidatePath("/dashboard/tasks");
}

export async function retryTaskAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const taskId = String(formData.get("taskId"));
  if (!taskId) throw new Error("Missing taskId");
  await retryTask(merchant.id, taskId);
  revalidatePath("/dashboard/tasks");
}

export async function confirmMemoryAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const memoryId = String(formData.get("memoryId"));
  if (!memoryId) throw new Error("Missing memoryId");
  const result = await confirmStatedMemory(merchant.id, memoryId);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/dashboard/memory");
}

export async function correctMemoryAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const memoryId = String(formData.get("memoryId"));
  const value = String(formData.get("value") ?? "");
  if (!memoryId) throw new Error("Missing memoryId");
  const result = await correctMemory(merchant.id, memoryId, value);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/dashboard/memory");
}

export async function deleteMemoryAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const memoryId = String(formData.get("memoryId"));
  if (!memoryId) throw new Error("Missing memoryId");
  const result = await deleteMemory(merchant.id, memoryId);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/dashboard/memory");
}

/**
 * Layer 25-3: on-demand trust score for one agent — fetched from a
 * "Show trust score" disclosure, never eagerly for every agent on page
 * load, matching runPreflightSimulation/explainDecisionAction's own
 * on-demand shape. getTrustScore itself re-verifies the agent belongs
 * to this merchant.
 */
export async function getTrustScoreAction(agentId: string): Promise<TrustReport | { error: string }> {
  const merchant = await requireSessionMerchant();
  try {
    return await getTrustScore(merchant.id, agentId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not compute trust score." };
  }
}

/**
 * Layer 25-1: the Bound Simulator. Re-verifies the agent belongs to
 * this merchant before replaying anything against it — same discipline
 * runPreflightSimulation already uses for the identical reason.
 */
export async function runBoundSimulationAction(formData: FormData): Promise<BoundSimulationResult | { error: string }> {
  const merchant = await requireSessionMerchant();
  const agentId = String(formData.get("agentId"));
  const hypotheticalCapRupees = Number(formData.get("hypotheticalCapRupees"));
  const hypotheticalPerTransactionMaxRupees = Number(formData.get("hypotheticalPerTransactionMaxRupees"));
  const windowDays = Number(formData.get("windowDays") ?? 30);

  const [agent] = await db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchant.id)));
  if (!agent) return { error: "Agent not found" };

  if (!Number.isFinite(hypotheticalCapRupees) || hypotheticalCapRupees <= 0 || !Number.isFinite(hypotheticalPerTransactionMaxRupees) || hypotheticalPerTransactionMaxRupees <= 0) {
    return { error: "Enter positive amounts for both fields" };
  }

  try {
    return await simulateBoundChange(
      agentId,
      Math.round(hypotheticalCapRupees * 100),
      Math.round(hypotheticalPerTransactionMaxRupees * 100),
      Number.isFinite(windowDays) && windowDays > 0 ? Math.min(windowDays, 90) : 30,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not run the simulation." };
  }
}

/**
 * Layer 25-2: the Kill Switch. Freeze/unfreeze both re-derive the
 * merchant from the session, never from anything the client asserts,
 * and both revalidate every dashboard surface — a frozen platform must
 * be unmistakable everywhere, not a banner on one page.
 */
export async function throwKillSwitchAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) throw new Error("A reason is required to freeze every agent.");
  await freezeAllAgents(merchant.id, reason);
  revalidatePath("/", "layout");
}

export async function releaseKillSwitchAction() {
  const merchant = await requireSessionMerchant();
  await unfreezeAllAgents(merchant.id);
  revalidatePath("/", "layout");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
