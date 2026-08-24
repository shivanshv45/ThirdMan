"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";
import { RazorpayCallError } from "@/lib/razorpay";

export async function connectRazorpay(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const keyId = String(formData.get("keyId") ?? "");
  const keySecret = String(formData.get("keySecret") ?? "");

  try {
    await mutations.connectRazorpay(merchant.id, keyId, keySecret);
  } catch (err) {
    // Razorpay's own rejection message ("Authentication failed", etc) is
    // the useful one to show — surface it rather than a generic failure.
    const message =
      err instanceof RazorpayCallError
        ? `Razorpay rejected these credentials: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Could not connect this Razorpay account.";
    redirect(`/dashboard/settings?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?connected=1");
}

export async function disconnectRazorpay() {
  const merchant = await requireSessionMerchant();
  await mutations.disconnectRazorpay(merchant.id);
  revalidatePath("/dashboard/settings");
}
