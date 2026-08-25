"use server";

import { revalidatePath } from "next/cache";
import { requireSessionMerchant } from "@/lib/auth";
import { parseCsv, extractFromPastedText, importCatalogueRows, type ImportRowPreview } from "@/lib/catalogue-import";

/**
 * Two-step Server Actions, mirroring catalogue-import.ts's own contract:
 * parse/extract never writes anything, confirmImport is the only
 * function in this file that does. The preview lives in the browser
 * (client component state) between the two calls — nothing about an
 * unconfirmed import touches the database.
 */

export async function parseCsvPreview(csvText: string) {
  await requireSessionMerchant();
  return parseCsv(csvText);
}

export async function extractPastedTextPreview(pastedText: string) {
  await requireSessionMerchant();
  return extractFromPastedText(pastedText);
}

export async function confirmImport(source: "csv" | "pasted_text", rows: ImportRowPreview[]) {
  const merchant = await requireSessionMerchant();
  const result = await importCatalogueRows(merchant.id, source, rows);
  revalidatePath("/dashboard/products");
  return result;
}
