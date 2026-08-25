import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { rupeesToPaise } from "@/lib/money";

/**
 * Merchant-authored bundle CRUD (Layer 6-1) — a bundle is the only thing
 * an offer can ever discount against, and this is the only place one is
 * created or edited. The gate (discount.ts's resolveOffer) only ever
 * reads a bundle's price back; it never computes one.
 */

const MAX_DISCOUNT_PERCENT = 40;

async function requireOwnedBundle(merchantId: string, bundleId: string) {
  const [bundle] = await db
    .select()
    .from(schema.bundles)
    .where(and(eq(schema.bundles.id, bundleId), eq(schema.bundles.merchantId, merchantId)));

  if (!bundle) throw new Error("Bundle not found");
  return bundle;
}

/** Loads the variants belonging to a merchant, for building a bundle from real stock rather than typed-in ids. */
export async function getMerchantVariantsForBundling(merchantId: string) {
  return db
    .select({
      id: schema.productVariants.id,
      sku: schema.productVariants.sku,
      pricePaise: schema.productVariants.pricePaise,
      costPaise: schema.productVariants.costPaise,
      productName: schema.products.name,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .where(and(eq(schema.productVariants.merchantId, merchantId), eq(schema.productVariants.status, "active")));
}

export interface CreateBundleInput {
  merchantId: string;
  name: string;
  items: { variantId: string; quantity: number }[];
  bundlePriceRupees: number;
  belowCostAcknowledged: boolean;
}

/**
 * Creates a bundle. The catalogue sum (what the items would cost bought
 * separately) and the summed costPaise floor are both computed here in
 * code from the real variant rows, never trusted from the form — the
 * same discipline gate.ts uses for a single variant's price. A bundle
 * priced below the max discount, or below the items' summed cost without
 * belowCostAcknowledged, is rejected outright rather than silently
 * clamped — a merchant should see the reason, not a surprised number.
 */
export async function createBundle(input: CreateBundleInput) {
  if (!input.name.trim()) throw new Error("Bundle name is required");
  if (input.items.length === 0) throw new Error("A bundle needs at least one item");
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`Invalid quantity for variant ${item.variantId}`);
    }
  }

  const variantIds = input.items.map((i) => i.variantId);
  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.merchantId, input.merchantId), eq(schema.productVariants.status, "active")));

  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const id of variantIds) {
    if (!byId.has(id)) throw new Error(`Variant ${id} not found for this merchant`);
  }

  const catalogueSumPaise = input.items.reduce((sum, item) => sum + byId.get(item.variantId)!.pricePaise * item.quantity, 0);
  const costSumPaise = input.items.reduce((sum, item) => sum + byId.get(item.variantId)!.costPaise * item.quantity, 0);
  const bundlePricePaise = rupeesToPaise(input.bundlePriceRupees);

  if (bundlePricePaise <= 0) throw new Error("Bundle price must be positive");

  const minAllowedPaise = Math.ceil(catalogueSumPaise * (1 - MAX_DISCOUNT_PERCENT / 100));
  if (bundlePricePaise < minAllowedPaise) {
    throw new Error(
      `Bundle price ₹${input.bundlePriceRupees.toFixed(2)} discounts more than the maximum ${MAX_DISCOUNT_PERCENT}% off the ₹${(catalogueSumPaise / 100).toFixed(2)} catalogue total (minimum ₹${(minAllowedPaise / 100).toFixed(2)}).`,
    );
  }

  if (bundlePricePaise < costSumPaise && !input.belowCostAcknowledged) {
    throw new Error(
      `Bundle price ₹${input.bundlePriceRupees.toFixed(2)} is below this bundle's total cost of ₹${(costSumPaise / 100).toFixed(2)}. Confirm to sell it at a loss deliberately.`,
    );
  }

  const [bundle] = await db
    .insert(schema.bundles)
    .values({
      merchantId: input.merchantId,
      name: input.name.trim(),
      bundlePricePaise,
      belowCostAcknowledged: bundlePricePaise < costSumPaise,
      status: "active",
    })
    .returning();

  await db.insert(schema.bundleItems).values(
    input.items.map((item) => ({
      bundleId: bundle.id,
      variantId: item.variantId,
      quantity: item.quantity,
    })),
  );

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "bundle_created",
    decision: "n/a",
    reason: `Merchant created bundle "${bundle.name}" at ₹${input.bundlePriceRupees.toFixed(2)} (catalogue total ₹${(catalogueSumPaise / 100).toFixed(2)}, ${input.items.length} item${input.items.length === 1 ? "" : "s"})${bundle.belowCostAcknowledged ? ", priced below the items' summed cost — acknowledged as a deliberate loss-leader" : ""}.`,
  });

  return bundle;
}

/** Deactivates a bundle so the offer engine can no longer offer it. Never deletes — a past offer/money_actions row keeps its reference. */
export async function archiveBundle(merchantId: string, bundleId: string) {
  const existing = await requireOwnedBundle(merchantId, bundleId);

  const [bundle] = await db
    .update(schema.bundles)
    .set({ status: "archived" })
    .where(eq(schema.bundles.id, bundleId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "bundle_archived",
    decision: "n/a",
    reason: `Merchant archived bundle "${existing.name}". It can no longer be offered.`,
  });

  return bundle;
}

export interface BundleWithItems {
  id: string;
  name: string;
  status: string;
  bundlePricePaise: number;
  belowCostAcknowledged: boolean;
  items: { variantId: string; sku: string; quantity: number; pricePaise: number }[];
}

/** Every bundle a merchant has authored, active first, with real item details joined in — what the dashboard and the offer engine both read. */
export async function getMerchantBundles(merchantId: string): Promise<BundleWithItems[]> {
  const bundleRows = await db.select().from(schema.bundles).where(eq(schema.bundles.merchantId, merchantId));

  const result: BundleWithItems[] = [];
  for (const bundle of bundleRows) {
    const items = await db
      .select({
        variantId: schema.bundleItems.variantId,
        quantity: schema.bundleItems.quantity,
        sku: schema.productVariants.sku,
        pricePaise: schema.productVariants.pricePaise,
      })
      .from(schema.bundleItems)
      .innerJoin(schema.productVariants, eq(schema.bundleItems.variantId, schema.productVariants.id))
      .where(eq(schema.bundleItems.bundleId, bundle.id));

    result.push({
      id: bundle.id,
      name: bundle.name,
      status: bundle.status,
      bundlePricePaise: bundle.bundlePricePaise,
      belowCostAcknowledged: bundle.belowCostAcknowledged,
      items,
    });
  }

  return result.sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
}
