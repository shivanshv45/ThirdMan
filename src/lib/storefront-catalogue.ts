import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Read-only, public-safe catalogue queries for the storefront (Layer
 * 4-2), the buyer chat (Layer 4-6), and the agent-facing catalogue
 * (Layer 4-4, restructured Layer 5-1). Deliberately never returns
 * costPaise — that column is internal-only (see
 * dashboard-mutations.ts's createProduct) and must never reach a
 * buyer-facing surface, human or agent.
 */

export interface PublicVariant {
  id: string;
  sku: string;
  pricePaise: number;
  stock: number;
  availability: string;
  attributes: Record<string, string>;
  gtin: string | null;
  mpn: string | null;
  imageUrl: string | null;
}

export interface PublicProduct {
  id: string;
  name: string;
  description: string;
  category: string;
  subcategory: string | null;
  variants: PublicVariant[];
}

function toPublicVariant(v: typeof schema.productVariants.$inferSelect): PublicVariant {
  return {
    id: v.id,
    sku: v.sku,
    pricePaise: v.pricePaise,
    stock: v.stock,
    availability: v.availability,
    attributes: (v.attributes as Record<string, string>) ?? {},
    gtin: v.gtin,
    mpn: v.mpn,
    imageUrl: v.imageUrl,
  };
}

function groupVariants(
  products: (typeof schema.products.$inferSelect)[],
  variants: (typeof schema.productVariants.$inferSelect)[],
): PublicProduct[] {
  return products
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      subcategory: p.subcategory,
      variants: variants.filter((v) => v.productId === p.id && v.status === "active").map(toPublicVariant),
    }))
    .filter((p) => p.variants.length > 0);
}

export async function getPublicCatalogue(merchantId: string): Promise<PublicProduct[]> {
  const [products, variants] = await Promise.all([
    db.select().from(schema.products).where(and(eq(schema.products.merchantId, merchantId), eq(schema.products.status, "active"))),
    db.select().from(schema.productVariants).where(and(eq(schema.productVariants.merchantId, merchantId), eq(schema.productVariants.status, "active"))),
  ]);

  return groupVariants(products, variants);
}

export async function getPublicProduct(merchantId: string, productId: string): Promise<PublicProduct | null> {
  const [product] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.merchantId, merchantId), eq(schema.products.status, "active")));

  if (!product) return null;

  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.productId, product.id), eq(schema.productVariants.status, "active")));

  const [result] = groupVariants([product], variants);
  return result ?? null;
}

export async function getMerchantStorefrontInfo(merchantId: string) {
  const [merchant] = await db
    .select({ id: schema.merchants.id, name: schema.merchants.name, connected: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant) return null;
  return { id: merchant.id, name: merchant.name, razorpayConnected: merchant.connected !== null };
}
