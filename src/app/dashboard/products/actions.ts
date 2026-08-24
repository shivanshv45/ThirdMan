"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";

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
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      priceRupees: Number(formData.get("priceRupees")),
      costRupees: Number(formData.get("costRupees")),
      stock: Number(formData.get("stock")),
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
