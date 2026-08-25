import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Agent-readiness scorer (Layer 5-6, prd.md §1 idea #1). A checklist over
 * real data — no model decides the score, matching CLAUDE.md rule 2. Every
 * check is a named constant with an integer weight, in this one file, so
 * a merchant (or a judge) can see precisely what's measured. Score is an
 * integer percentage of (weight of passed checks) / (total weight) —
 * never a float.
 */

const MIN_DESCRIPTION_LENGTH = 20;

export interface ReadinessCheck {
  id: string;
  label: string;
  weight: number;
  passed: boolean;
  /** Present only when the check failed — what to fix and where. */
  fix?: { message: string; href: string };
}

export interface ReadinessReport {
  score: number;
  checks: ReadinessCheck[];
}

interface ReadinessInputs {
  razorpayConnected: boolean;
  products: { id: string; description: string; category: string; variants: { sku: string; attributes: Record<string, unknown> }[] }[];
  policyPublished: boolean;
  shippingRegionsSet: boolean;
  hasAgentWithActiveCap: boolean;
  productsWithImages: number;
  activeProductCount: number;
}

/**
 * Every check the score is built from, as named, weighted, pure
 * predicates over ReadinessInputs — nothing here reads the DB or calls a
 * model. Kept as an ordered array (not an object) so the report's checks
 * always render in the same, deliberate order.
 */
const CHECKS: { id: string; label: string; weight: number; check: (i: ReadinessInputs) => boolean; fixMessage: string; fixHref: string }[] = [
  {
    id: "razorpay_connected",
    label: "Razorpay account connected",
    weight: 20,
    check: (i) => i.razorpayConnected,
    fixMessage: "Connect your Razorpay test account — agents cannot transact without it.",
    fixHref: "/dashboard/settings",
  },
  {
    id: "has_active_product",
    label: "At least one active product",
    weight: 20,
    check: (i) => i.activeProductCount > 0,
    fixMessage: "Add at least one product to your catalogue.",
    fixHref: "/dashboard/products",
  },
  {
    id: "descriptions_adequate",
    label: `Every product has a description of at least ${MIN_DESCRIPTION_LENGTH} characters`,
    weight: 15,
    check: (i) => i.activeProductCount > 0 && i.products.every((p) => p.description.trim().length >= MIN_DESCRIPTION_LENGTH),
    fixMessage: "Some products have a thin or missing description — an agent can't tell what they are.",
    fixHref: "/dashboard/products",
  },
  {
    id: "every_variant_has_sku",
    label: "Every variant has a SKU",
    weight: 10,
    check: (i) => i.activeProductCount > 0 && i.products.every((p) => p.variants.every((v) => v.sku.trim().length > 0)),
    fixMessage: "Some variants have no SKU — an agent has no stable id to reorder by.",
    fixHref: "/dashboard/products",
  },
  {
    id: "every_variant_has_attribute",
    label: "Every variant has at least one attribute",
    weight: 5,
    check: (i) => i.activeProductCount > 0 && i.products.every((p) => p.variants.every((v) => Object.keys(v.attributes ?? {}).length > 0)),
    fixMessage: "Some variants have no attributes (e.g. size, colour) — an agent can't tell them apart from prose alone.",
    fixHref: "/dashboard/products",
  },
  {
    id: "category_set",
    label: "Every product has a real category",
    weight: 5,
    check: (i) => i.activeProductCount > 0 && i.products.every((p) => p.category !== "other"),
    fixMessage: "Some products are categorised as \"other\" — pick a real category so agents can filter and compare.",
    fixHref: "/dashboard/products",
  },
  {
    id: "return_policy_published",
    label: "Return policy published",
    weight: 15,
    check: (i) => i.policyPublished,
    fixMessage: "Publish a return policy — a cautious buyer agent may skip a merchant it can't determine terms for.",
    fixHref: "/dashboard/policies",
  },
  {
    id: "shipping_regions_set",
    label: "Shipping regions set",
    weight: 5,
    check: (i) => i.shippingRegionsSet,
    fixMessage: "List the regions you ship to in your policy.",
    fixHref: "/dashboard/policies",
  },
  {
    id: "agent_with_cap_exists",
    label: "At least one agent exists with an active spend cap",
    weight: 5,
    check: (i) => i.hasAgentWithActiveCap,
    fixMessage: "Create an agent and set its spend cap — this is what a buyer agent actually authenticates as.",
    fixHref: "/dashboard",
  },
  {
    id: "has_images",
    label: "Products have images",
    weight: 2, // low weight per the plan: "nice, not required" — present but barely moves the score
    check: (i) => i.activeProductCount > 0 && i.productsWithImages === i.activeProductCount,
    fixMessage: "Add an image URL to your products — agents increasingly consume images.",
    fixHref: "/dashboard/products",
  },
];

export function computeReadiness(inputs: ReadinessInputs): ReadinessReport {
  const checks: ReadinessCheck[] = CHECKS.map((c) => {
    const passed = c.check(inputs);
    return {
      id: c.id,
      label: c.label,
      weight: c.weight,
      passed,
      fix: passed ? undefined : { message: c.fixMessage, href: c.fixHref },
    };
  });

  const totalWeight = CHECKS.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = checks.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

  return { score, checks };
}

/** Loads real data and computes the report — the only place this module touches the DB. */
export async function getAgentReadiness(merchantId: string): Promise<ReadinessReport> {
  const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, merchantId));
  const razorpayConnected = merchant?.razorpayKeyIdEncrypted != null;

  const [products, variants, policy, agents] = await Promise.all([
    db.select().from(schema.products).where(eq(schema.products.merchantId, merchantId)),
    db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId)),
    db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId)),
    db.select().from(schema.agents).where(eq(schema.agents.merchantId, merchantId)),
  ]);

  const activeProducts = products.filter((p) => p.status === "active");
  const productsForCheck = activeProducts.map((p) => ({
    id: p.id,
    description: p.description,
    category: p.category,
    variants: variants
      .filter((v) => v.productId === p.id && v.status === "active")
      .map((v) => ({ sku: v.sku, attributes: v.attributes as Record<string, unknown> })),
  }));

  const productsWithImages = productsForCheck.filter((p) => {
    const productVariants = variants.filter((v) => v.productId === p.id);
    return productVariants.length > 0 && productVariants.every((v) => v.imageUrl);
  }).length;

  let hasAgentWithActiveCap = false;
  for (const agent of agents) {
    const [cap] = await db
      .select()
      .from(schema.spendCaps)
      .where(eq(schema.spendCaps.agentId, agent.id))
      .orderBy(desc(schema.spendCaps.createdAt))
      .limit(1);
    if (cap?.status === "active") {
      hasAgentWithActiveCap = true;
      break;
    }
  }

  return computeReadiness({
    razorpayConnected,
    products: productsForCheck,
    policyPublished: policy.length > 0,
    shippingRegionsSet: (policy[0]?.shippingRegions.length ?? 0) > 0,
    hasAgentWithActiveCap,
    productsWithImages,
    activeProductCount: activeProducts.length,
  });
}
