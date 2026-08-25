"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";

export async function setMerchantPolicy(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const returnsAccepted = formData.get("returnsAccepted") === "on";
  const returnWindowDaysRaw = formData.get("returnWindowDays");
  const restockingFeeRaw = formData.get("restockingFeePercent");
  const handlingTimeRaw = formData.get("handlingTimeDays");
  const warrantyRaw = formData.get("warrantyMonths");
  const shippingRegionsRaw = String(formData.get("shippingRegions") ?? "");

  try {
    await mutations.setMerchantPolicy({
      merchantId: merchant.id,
      returnsAccepted,
      returnWindowDays: returnWindowDaysRaw ? Number(returnWindowDaysRaw) : null,
      refundMethod: (formData.get("refundMethod") as "original_payment_method" | "store_credit" | "either" | null) || null,
      restockingFeePercent: restockingFeeRaw ? Number(restockingFeeRaw) : null,
      shippingRegions: shippingRegionsRaw
        .split(",")
        .map((r) => r.trim().toUpperCase())
        .filter(Boolean),
      handlingTimeDays: handlingTimeRaw ? Number(handlingTimeRaw) : null,
      warrantyMonths: warrantyRaw ? Number(warrantyRaw) : null,
      policyNotes: String(formData.get("policyNotes") ?? ""),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save policy.";
    redirect(`/dashboard/policies?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/policies");
}
