"use server";

import { revalidatePath } from "next/cache";
import { requireSessionMerchant } from "@/lib/auth";
import { loadDemoFailureBatch } from "@/lib/recovery/demo-batch";
import { runRecoveryBatch, runRecoveryForFailure } from "@/lib/recovery/sequencer";
import { getRecoveryStats, getFailureQueue } from "@/lib/recovery/attribution";
import { createRecoverySequenceTask } from "@/lib/runtime/runner";

/**
 * Thin Server Action wrappers, same discipline as app/dashboard/actions.ts:
 * resolve the session merchant, delegate to framework-agnostic logic,
 * revalidate. Every action re-derives the merchant from the session
 * rather than trusting a client-supplied merchantId.
 */

export async function loadDemoBatchAction() {
  const merchant = await requireSessionMerchant();
  await loadDemoFailureBatch(merchant.id);
  revalidatePath("/dashboard/recovery");
}

export async function runRecoveryBatchAction() {
  const merchant = await requireSessionMerchant();
  await runRecoveryBatch(merchant.id);
  revalidatePath("/dashboard/recovery");
}

export async function runSingleRecoveryAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const failureId = String(formData.get("failureId") ?? "");
  if (!failureId) throw new Error("Missing failureId");
  await runRecoveryForFailure(merchant.id, failureId);
  revalidatePath("/dashboard/recovery");
}

/**
 * Layer 17: queues the SAME failure through the durable runtime instead
 * of running it synchronously here — one step now, the rest advanced by
 * /api/cron/run's tick across whatever real backoff window the recovery
 * policy computes. Idempotent by failureId (createRecoverySequenceTask),
 * so clicking this on a failure that already has a task just surfaces
 * the existing one rather than starting a second runner racing the
 * first.
 */
export async function queueRecoveryTaskAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const failureId = String(formData.get("failureId") ?? "");
  if (!failureId) throw new Error("Missing failureId");
  await createRecoverySequenceTask(merchant.id, failureId);
  revalidatePath("/dashboard/recovery");
  revalidatePath("/dashboard/tasks");
}

export type RecoveryStatsResult = Awaited<ReturnType<typeof getRecoveryStats>>;
export type FailureQueueResult = Awaited<ReturnType<typeof getFailureQueue>>;

export async function refreshRecoveryData(): Promise<{
  stats: RecoveryStatsResult;
  queue: FailureQueueResult;
}> {
  const merchant = await requireSessionMerchant();
  const [stats, queue] = await Promise.all([getRecoveryStats(merchant.id), getFailureQueue(merchant.id)]);
  return { stats, queue };
}

// --- Section chat bar (draft/confirm, no direct write from a model) ---

import { draftRecoveryAction, type ChatTurn } from "@/lib/section-chat/recovery-draft";
import { confirmRecoveryAction } from "@/lib/section-chat/recovery-confirm";
import type { RecoveryProposal } from "@/lib/section-chat/recovery-schema";

export async function draftRecoveryChatAction(history: ChatTurn[]) {
  const merchant = await requireSessionMerchant();
  return draftRecoveryAction(merchant.id, history);
}

export async function confirmRecoveryChatAction(proposal: RecoveryProposal) {
  const merchant = await requireSessionMerchant();
  const result = await confirmRecoveryAction(merchant.id, proposal);
  if (result.ok) revalidatePath("/dashboard/recovery");
  return result;
}
