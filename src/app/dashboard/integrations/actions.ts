"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { generateWooCommercePluginForMerchant } from "@/lib/woocommerce-plugin";
import { generateUnsupportedPlatformSpec } from "@/lib/unsupported-platform-spec";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { getAppUrl } from "@/lib/env";
import { logAuditEntry } from "@/lib/audit";

export type WooCommercePluginState = { filename: string; content: string; error?: undefined } | { filename?: undefined; content?: undefined; error: string } | null;

export async function generateWooCommercePluginAction(_prev: WooCommercePluginState, _formData: FormData): Promise<WooCommercePluginState> {
  const merchant = await requireSessionMerchant();
  try {
    const { filename, content } = await generateWooCommercePluginForMerchant(merchant.id, merchant.name);
    return { filename, content };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not generate the plugin." };
  }
}

export type UnsupportedPlatformSpecState = { content: string; error?: undefined } | { content?: undefined; error: string } | null;

export async function generateUnsupportedPlatformSpecAction(_prev: UnsupportedPlatformSpecState, _formData: FormData): Promise<UnsupportedPlatformSpecState> {
  const merchant = await requireSessionMerchant();
  try {
    const embedConfig = await getOrCreateEmbedConfig(merchant.id);
    const content = generateUnsupportedPlatformSpec({
      merchantId: merchant.id,
      merchantName: merchant.name,
      appOrigin: getAppUrl(),
      publishableKey: embedConfig.publishableKey,
    });

    await logAuditEntry({
      merchantId: merchant.id,
      actor: "merchant",
      event: "unsupported_platform_spec_generated",
      decision: "n/a",
      reason: "Merchant generated the unrecognised-platform integration spec from the dashboard.",
    });

    return { content };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not generate the spec." };
  }
}
