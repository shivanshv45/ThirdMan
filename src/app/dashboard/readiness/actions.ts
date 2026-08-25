"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { suggestProductDescription } from "@/lib/description-suggestion";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";

/** Generates a draft description for one of the merchant's own products — never writes it, the merchant reviews and saves it via the existing product edit form. */
export async function suggestDescription(productId: string): Promise<{ suggestion?: string; error?: string }> {
  const merchant = await requireSessionMerchant();

  const [product] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.merchantId, merchant.id)));
  if (!product) return { error: "Product not found" };

  const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, productId));

  try {
    const suggestion = await suggestProductDescription({
      name: product.name,
      category: product.category,
      existingDescription: product.description,
      attributes: variants.map((v) => v.attributes as Record<string, string>),
    });
    return { suggestion };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not generate a suggestion right now." };
  }
}
