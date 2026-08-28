"use server";

import { revalidatePath } from "next/cache";
import { requireSessionMerchant } from "@/lib/auth";
import { updateEmbedOrigins, updateEmbedAppearance, setEmbedStatus, rotateEmbedKey } from "@/lib/embed-mutations";
import { registerMerchantWebhook, updateMerchantWebhook, setMerchantWebhookStatus } from "@/lib/merchant-webhooks";
import { enqueueTestDelivery } from "@/lib/webhooks/enqueue";
import { retryDelivery } from "@/lib/webhooks/runner";

/**
 * Thin Server Action wrappers around embed-mutations.ts/merchant-
 * webhooks.ts's testable logic — same split dashboard-mutations.ts's
 * own actions.ts already established.
 */

export async function updateOrigins(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const raw = String(formData.get("origins") ?? "");
  const origins = raw
    .split(/[\n,]/)
    .map((o) => o.trim())
    .filter(Boolean);

  try {
    await updateEmbedOrigins({ merchantId: merchant.id, origins });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not update origins.";
    revalidatePath("/dashboard/embed");
    throw new Error(message);
  }
  revalidatePath("/dashboard/embed");
}

export async function updateAppearance(formData: FormData) {
  const merchant = await requireSessionMerchant();

  await updateEmbedAppearance({
    merchantId: merchant.id,
    displayName: String(formData.get("displayName") ?? "").trim() || null,
    accentColor: String(formData.get("accentColor") ?? "").trim() || null,
    greeting: String(formData.get("greeting") ?? "").trim() || null,
    position: formData.get("position") === "bottom_left" ? "bottom_left" : "bottom_right",
    negotiationEnabled: formData.get("negotiationEnabled") === "on",
    offersEnabled: formData.get("offersEnabled") === "on",
  });
  revalidatePath("/dashboard/embed");
}

export async function toggleEmbedStatus(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const status = formData.get("status") === "disabled" ? "disabled" : "active";
  await setEmbedStatus(merchant.id, status);
  revalidatePath("/dashboard/embed");
}

export type RotateEmbedKeyState = { rawKey: string } | { error: string } | null;

export async function rotateEmbedKeyAction(_prev: RotateEmbedKeyState, _formData: FormData): Promise<RotateEmbedKeyState> {
  const merchant = await requireSessionMerchant();
  try {
    const config = await rotateEmbedKey(merchant.id);
    revalidatePath("/dashboard/embed");
    return { rawKey: config.publishableKey };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not rotate the embed key." };
  }
}

export type RegisterWebhookState = { rawSecret: string } | { error: string } | null;

export async function registerWebhookAction(_prev: RegisterWebhookState, formData: FormData): Promise<RegisterWebhookState> {
  const merchant = await requireSessionMerchant();
  const url = String(formData.get("url") ?? "").trim();
  const events = formData.getAll("events").map(String);

  try {
    const { rawSecret } = await registerMerchantWebhook({ merchantId: merchant.id, url, events });
    revalidatePath("/dashboard/embed");
    return { rawSecret };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not register webhook." };
  }
}

export async function updateWebhook(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const webhookId = String(formData.get("webhookId") ?? "");
  const url = String(formData.get("url") ?? "").trim();
  const events = formData.getAll("events").map(String);

  await updateMerchantWebhook({ merchantId: merchant.id, webhookId, url, events });
  revalidatePath("/dashboard/embed");
}

export async function toggleWebhookStatus(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const webhookId = String(formData.get("webhookId") ?? "");
  const status = formData.get("status") === "disabled" ? "disabled" : "active";
  await setMerchantWebhookStatus(merchant.id, webhookId, status);
  revalidatePath("/dashboard/embed");
}

export async function sendTestDelivery(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const webhookId = String(formData.get("webhookId") ?? "");
  await enqueueTestDelivery(merchant.id, webhookId);
  revalidatePath("/dashboard/embed");
}

export async function retryDeliveryAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const deliveryId = String(formData.get("deliveryId") ?? "");
  await retryDelivery(merchant.id, deliveryId);
  revalidatePath("/dashboard/embed");
}
