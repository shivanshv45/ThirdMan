"use server";

import { revalidatePath } from "next/cache";
import { requireSessionMerchant } from "@/lib/auth";
import { loadDemoFailureBatch } from "@/lib/recovery/demo-batch";
import { runRecoveryBatch, runRecoveryForFailure } from "@/lib/recovery/sequencer";
import { getRecoveryStats, getFailureQueue } from "@/lib/recovery/attribution";

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
