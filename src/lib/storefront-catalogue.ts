import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Read-only, public-safe catalogue queries for the storefront (Layer
 * 4-2) and the agent-facing catalogue (Layer 4-4). Deliberately never
 * returns costPaise — that column is internal-only (see
 * dashboard-mutations.ts's createProduct) and must never reach a
 * buyer-facing surface, human or agent.
 */

export interface PublicProduct {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  stock: number;
}

function toPublicProduct(p: typeof schema.products.$inferSelect): PublicProduct {
  return { id: p.id, name: p.name, description: p.description, pricePaise: p.pricePaise, stock: p.stock };
}

export async function getPublicCatalogue(merchantId: string): Promise<PublicProduct[]> {
  const products = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.merchantId, merchantId), eq(schema.products.status, "active")));

  return products.map(toPublicProduct);
}

export async function getPublicProduct(merchantId: string, productId: string): Promise<PublicProduct | null> {
  const [product] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.merchantId, merchantId), eq(schema.products.status, "active")));

  return product ? toPublicProduct(product) : null;
}

export async function getMerchantStorefrontInfo(merchantId: string) {
  const [merchant] = await db
    .select({ id: schema.merchants.id, name: schema.merchants.name, connected: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant) return null;
  return { id: merchant.id, name: merchant.name, razorpayConnected: merchant.connected !== null };
}
