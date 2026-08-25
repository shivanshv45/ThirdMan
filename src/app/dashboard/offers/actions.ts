"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as bundles from "@/lib/bundles";
import { requireSessionMerchant } from "@/lib/auth";

export async function createBundle(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const name = String(formData.get("name") ?? "");
  const bundlePriceRupees = Number(formData.get("bundlePriceRupees"));
  const belowCostAcknowledged = formData.get("belowCostAcknowledged") === "on";

  // The form submits one row per selected variant as "item:<variantId>"
  // checkboxes plus a matching "qty:<variantId>" quantity input — parsed
  // here rather than trusting a client-assembled items array.
  const items: { variantId: string; quantity: number }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("item:") || value !== "on") continue;
    const variantId = key.slice("item:".length);
    const qtyRaw = formData.get(`qty:${variantId}`);
    const quantity = qtyRaw ? Number(qtyRaw) : 1;
    items.push({ variantId, quantity });
  }

  try {
    await bundles.createBundle({
      merchantId: merchant.id,
      name,
      items,
      bundlePriceRupees,
      belowCostAcknowledged,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create bundle.";
    redirect(`/dashboard/offers?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/offers");
}

export async function archiveBundle(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const bundleId = String(formData.get("bundleId"));

  try {
    await bundles.archiveBundle(merchant.id, bundleId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not archive bundle.";
    redirect(`/dashboard/offers?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/offers");
}
