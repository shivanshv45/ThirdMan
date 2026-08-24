"use server";

import { revalidatePath } from "next/cache";
import { requireSessionMerchant } from "@/lib/auth";
import { captureHeldPayment, issueRefund } from "@/lib/gate";
import { sweepExpiredHolds } from "@/lib/escrow";

export async function releaseHold(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const moneyActionId = String(formData.get("moneyActionId"));
  await captureHeldPayment(merchant.id, moneyActionId);
  revalidatePath("/dashboard/escrow");
}

export async function refundHold(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const moneyActionId = String(formData.get("moneyActionId"));
  await issueRefund(merchant.id, moneyActionId);
  revalidatePath("/dashboard/escrow");
}

/** Called on page load — sweeps any hold past its deterministic expiry before rendering, so an expired hold never lingers as "held" on screen. */
export async function sweepOnLoad(merchantId: string) {
  return sweepExpiredHolds(merchantId);
}
