"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";
import { TIER_PRESETS } from "./tier-presets";

export async function setRewardSettings(formData: FormData) {
  const merchant = await requireSessionMerchant();

  try {
    await mutations.setRewardSettings({
      merchantId: merchant.id,
      paisePerCoinRupees: Number(formData.get("paisePerCoinRupees")),
      issueRatePermille: Number(formData.get("issueRatePermille")),
      maxRedemptionPercent: Number(formData.get("maxRedemptionPercent")),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save reward settings.";
    redirect(`/dashboard/rewards?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/rewards");
}

export async function createAiCreditTier(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const modelId = String(formData.get("modelId") ?? "");
  const preset = TIER_PRESETS.find((p) => p.modelId === modelId);
  if (!preset) {
    redirect(`/dashboard/rewards?error=${encodeURIComponent("Unknown model.")}`);
  }

  try {
    await mutations.createAiCreditTier({
      merchantId: merchant.id,
      modelId: preset.modelId,
      displayName: preset.displayName,
      provider: "groq",
      coinsPerRequest: Number(formData.get("coinsPerRequest")),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not add tier.";
    redirect(`/dashboard/rewards?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/rewards");
}

export async function toggleAiCreditTier(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const tierId = String(formData.get("tierId") ?? "");
  const enabled = formData.get("enabled") === "true";
  await mutations.setAiCreditTierEnabled(merchant.id, tierId, enabled);
  revalidatePath("/dashboard/rewards");
}

// --- Section chat bar (draft/confirm, no direct write from a model) ---

import { draftRewardsAction, type ChatTurn } from "@/lib/section-chat/rewards-draft";
import { confirmRewardsAction } from "@/lib/section-chat/rewards-confirm";
import type { RewardsProposal } from "@/lib/section-chat/rewards-schema";

export async function draftRewardsChatAction(history: ChatTurn[]) {
  const merchant = await requireSessionMerchant();
  return draftRewardsAction(merchant.id, history);
}

export async function confirmRewardsChatAction(proposal: RewardsProposal) {
  const merchant = await requireSessionMerchant();
  const result = await confirmRewardsAction(merchant.id, proposal);
  if (result.ok) revalidatePath("/dashboard/rewards");
  return result;
}
