"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";

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
