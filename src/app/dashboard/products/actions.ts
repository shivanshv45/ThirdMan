"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";
import { draftProductsAction, type ChatTurn } from "@/lib/section-chat/products-draft";
import { confirmProductsAction } from "@/lib/section-chat/products-confirm";
import type { ProductsProposal } from "@/lib/section-chat/products-schema";

export async function draftProductsChatAction(history: ChatTurn[]) {
  const merchant = await requireSessionMerchant();
  return draftProductsAction(merchant.id, history);
}

export async function confirmProductsChatAction(proposal: ProductsProposal) {
  const merchant = await requireSessionMerchant();
  const result = await confirmProductsAction(merchant.id, proposal);
  if (result.ok) revalidatePath("/dashboard/products");
  return result;
}

/**
 * Thin Server Action wrappers, same pattern as app/dashboard/actions.ts —
 * resolve the session merchant, parse FormData, delegate to the
 * framework-agnostic logic in dashboard-mutations.ts, then revalidate.
 */

export async function createProduct(formData: FormData) {
  const merchant = await requireSessionMerchant();

  try {
    await mutations.createProduct({
      merchantId: merchant.id,
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      priceRupees: Number(formData.get("priceRupees")),
      costRupees: Number(formData.get("costRupees")),
      stock: Number(formData.get("stock")),
      sku: String(formData.get("sku") ?? ""),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create product.";
    redirect(`/dashboard/products?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/products");
}

export async function updateProduct(formData: FormData) {
  const merchant = await requireSessionMerchant();

  try {
    await mutations.updateProduct({
      merchantId: merchant.id,
      productId: String(formData.get("productId")),
      variantId: String(formData.get("variantId")),
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      priceRupees: Number(formData.get("priceRupees")),
      costRupees: Number(formData.get("costRupees")),
      stock: Number(formData.get("stock")),
      sku: String(formData.get("sku") ?? ""),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not update product.";
    redirect(`/dashboard/products?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/products");
}

export async function archiveProduct(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.archiveProduct(merchant.id, String(formData.get("productId")));
  revalidatePath("/dashboard/products");
}

export async function reactivateProduct(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.reactivateProduct(merchant.id, String(formData.get("productId")));
  revalidatePath("/dashboard/products");
}

export async function addVariant(formData: FormData) {
  const merchant = await requireSessionMerchant();

  try {
    await mutations.addVariant({
      merchantId: merchant.id,
      productId: String(formData.get("productId")),
      sku: String(formData.get("sku") ?? ""),
      priceRupees: Number(formData.get("priceRupees")),
      costRupees: Number(formData.get("costRupees")),
      stock: Number(formData.get("stock")),
      attributeKey: String(formData.get("attributeKey") ?? ""),
      attributeValue: String(formData.get("attributeValue") ?? ""),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not add variant.";
    redirect(`/dashboard/products?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/products");
}

export async function updateVariant(formData: FormData) {
  const merchant = await requireSessionMerchant();

  try {
    await mutations.updateVariant({
      merchantId: merchant.id,
      variantId: String(formData.get("variantId")),
      sku: String(formData.get("sku") ?? ""),
      priceRupees: Number(formData.get("priceRupees")),
      costRupees: Number(formData.get("costRupees")),
      stock: Number(formData.get("stock")),
      attributeKey: String(formData.get("attributeKey") ?? ""),
      attributeValue: String(formData.get("attributeValue") ?? ""),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not update variant.";
    redirect(`/dashboard/products?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/products");
}

export async function archiveVariant(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.archiveVariant(merchant.id, String(formData.get("variantId")));
  revalidatePath("/dashboard/products");
}

export async function reactivateVariant(formData: FormData) {
  const merchant = await requireSessionMerchant();
  await mutations.reactivateVariant(merchant.id, String(formData.get("variantId")));
  revalidatePath("/dashboard/products");
}
