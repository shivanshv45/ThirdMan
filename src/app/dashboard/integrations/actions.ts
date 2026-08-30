"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { generateWooCommercePluginForMerchant } from "@/lib/woocommerce-plugin";
import { generateUnsupportedPlatformSpec } from "@/lib/unsupported-platform-spec";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { getAppUrl } from "@/lib/env";
import { logAuditEntry } from "@/lib/audit";
import { fetchShopifyCatalogue, confirmShopifySync, disconnectShopify, getShopifyConnection, isShopifyConfigured } from "@/lib/shopify";
import type { ImportRowPreview } from "@/lib/catalogue-import";

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

export async function getShopifyStatusAction(): Promise<{ configured: boolean; connection: Awaited<ReturnType<typeof getShopifyConnection>> }> {
  const merchant = await requireSessionMerchant();
  const connection = await getShopifyConnection(merchant.id);
  return { configured: isShopifyConfigured(), connection };
}

export type ShopifyPreviewState = { rows: ImportRowPreview[]; isTruncated: boolean; error?: undefined } | { rows?: undefined; isTruncated?: undefined; error: string } | null;

/**
 * L24-3's catalogue sync, step one: fetch the real Admin API catalogue
 * into the same ImportRowPreview shape catalogue-import.ts's other two
 * sources produce — the merchant sees real parsed rows before anything
 * is written, exactly like the CSV and pasted-text paths.
 */
export async function previewShopifySyncAction(): Promise<ShopifyPreviewState> {
  const merchant = await requireSessionMerchant();
  try {
    const { rows, isTruncated } = await fetchShopifyCatalogue(merchant.id);
    return { rows, isTruncated };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not fetch your Shopify catalogue." };
  }
}

export type ShopifyConfirmState = { rowsImported: number; rowsSkipped: number; error?: undefined } | { rowsImported?: undefined; rowsSkipped?: undefined; error: string } | null;

/** Step two: writes exactly the rows the merchant saw in the preview — through importCatalogueRows, the one write path every source shares. */
export async function confirmShopifySyncAction(rows: ImportRowPreview[]): Promise<ShopifyConfirmState> {
  const merchant = await requireSessionMerchant();
  try {
    const result = await confirmShopifySync(merchant.id, rows);
    return { rowsImported: result.rowsImported, rowsSkipped: result.rowsSkipped };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not import the catalogue." };
  }
}

export async function disconnectShopifyAction(): Promise<void> {
  const merchant = await requireSessionMerchant();
  await disconnectShopify(merchant.id);
}
