"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant, getCurrentSessionId } from "@/lib/auth";
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

export async function updateAlertSettings(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.updateAlertSettings(merchant.id, {
    escalationPendingEnabled: formData.get("escalationPendingEnabled") === "on",
    holdExpiringEnabled: formData.get("holdExpiringEnabled") === "on",
    notificationExhaustedEnabled: formData.get("notificationExhaustedEnabled") === "on",
    webhookExhaustedEnabled: formData.get("webhookExhaustedEnabled") === "on",
    loginBurstEnabled: formData.get("loginBurstEnabled") === "on",
  });
  revalidatePath("/dashboard/settings");
}

export async function changePassword(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword !== confirmPassword) {
    redirect(`/dashboard/settings?pwError=${encodeURIComponent("New password and confirmation don't match.")}`);
  }

  const currentSessionId = await getCurrentSessionId();

  try {
    await mutations.changePassword(merchant.id, currentSessionId, currentPassword, newPassword);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not change password.";
    redirect(`/dashboard/settings?pwError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?pwChanged=1");
}
