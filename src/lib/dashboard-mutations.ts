import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { encrypt } from "@/lib/crypto";
import { validateCredentials } from "@/lib/razorpay";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { rupeesToPaise } from "@/lib/money";

/**
 * The framework-agnostic core of every dashboard mutation. Separated
 * from src/app/dashboard/actions.ts so this logic is directly testable
 * without a Next.js request context — revalidatePath() throws outside
 * one, which the thin Server Action wrappers call after these return.
 */

/** Loads an agent and throws unless it belongs to the given merchant, so no mutation can act on another merchant's agent by id alone. */
async function requireOwnedAgent(merchantId: string, agentId: string) {
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchantId)));

  if (!agent) throw new Error("Agent not found");
  return agent;
}

export interface SetSpendCapInput {
  merchantId: string;
  agentId: string;
  capRupees: number;
  perTransactionMaxRupees: number;
  windowHours: number;
}

export async function setSpendCap(input: SetSpendCapInput) {
  if (!input.agentId || !Number.isFinite(input.capRupees) || input.capRupees <= 0) {
    throw new Error("Invalid cap parameters");
  }

  await requireOwnedAgent(input.merchantId, input.agentId);

  const capPaise = rupeesToPaise(input.capRupees);
  const perTransactionMaxPaise = rupeesToPaise(input.perTransactionMaxRupees);
  const now = new Date();

  // Revoke any existing active cap for this agent before creating a new
  // one, so checkBounds's "most recent cap" lookup always finds exactly
  // the intended cap and old ones don't linger as stale active rows.
  await db.update(schema.spendCaps).set({ status: "revoked" }).where(eq(schema.spendCaps.agentId, input.agentId));

  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: input.agentId,
      capPaise,
      spentPaise: 0,
      perTransactionMaxPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + input.windowHours * 60 * 60 * 1000),
      status: "active",
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "spend_cap_set",
    decision: "n/a",
    reason: `Merchant set a new spend cap of ₹${input.capRupees.toFixed(2)} (₹${input.perTransactionMaxRupees.toFixed(2)} per transaction, ${input.windowHours}h window) for agent ${input.agentId}.`,
    boundApplied: `spend_cap:${cap.id}`,
  });

  return cap;
}

/**
 * Creates a new agent for this merchant and generates its API key. The
 * raw key is returned exactly once — only its hash is ever persisted.
 * Callers (the Server Action, and by extension the settings page) must
 * display it immediately and never log or re-derive it afterward.
 */
export async function createAgent(merchantId: string, name: string) {
  if (!name.trim()) throw new Error("Agent name is required");

  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: name.trim(),
      apiKeyHash: hashApiKey(rawKey),
      status: "active",
    })
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_created",
    decision: "n/a",
    reason: `Merchant created agent "${agent.name}" and issued a new API key.`,
  });

  return { agent, rawKey };
}

/**
 * Layer 13-2: replaces the exact set of capabilities an agent holds.
 * Full-replace, not incremental add/remove — a merchant sees a checkbox
 * form reflecting current state and submits the new complete set, the
 * same "one form is the whole truth" shape setMerchantPolicy already
 * uses. A newly created agent starts with none granted (deny by
 * default); only an existing merchant's explicit backfill (this
 * migration) or this action ever grants one.
 */
export async function setAgentCapabilities(
  merchantId: string,
  agentId: string,
  capabilities: (typeof schema.agentCapabilityEnum.enumValues)[number][],
) {
  const agent = await requireOwnedAgent(merchantId, agentId);

  const validCapabilities = new Set(schema.agentCapabilityEnum.enumValues);
  const deduped = [...new Set(capabilities)].filter((c) => validCapabilities.has(c));

  await db.transaction(async (tx) => {
    await tx.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agentId));
    if (deduped.length > 0) {
      await tx.insert(schema.agentCapabilities).values(deduped.map((capability) => ({ agentId, capability })));
    }
  });

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_capabilities_set",
    decision: "n/a",
    reason: `Merchant set agent "${agent.name}"'s capabilities to: ${deduped.length > 0 ? deduped.join(", ") : "none"}.`,
    metadata: { agentId, capabilities: deduped },
  });

  return deduped;
}

/** Layer 13-3: turns AP2 mandate presentation on/off per agent. Opt-in — false (the default) means today's unchanged purchase flow. */
export async function setAgentMandateRequired(merchantId: string, agentId: string, required: boolean) {
  const agent = await requireOwnedAgent(merchantId, agentId);

  await db.update(schema.agents).set({ mandateRequired: required }).where(eq(schema.agents.id, agentId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_mandate_requirement_set",
    decision: "n/a",
    reason: `Merchant ${required ? "required" : "no longer requires"} an AP2 payment mandate for agent "${agent.name}"'s purchases.`,
    metadata: { agentId, mandateRequired: required },
  });
}

/**
 * Replaces an agent's API key. The old key stops working immediately —
 * this is how a merchant responds to a leak without losing the agent's
 * caps or audit history, which deleting and recreating would orphan.
 */
export async function rotateAgentKey(merchantId: string, agentId: string) {
  const existing = await requireOwnedAgent(merchantId, agentId);

  const rawKey = generateApiKey();
  const [agent] = await db
    .update(schema.agents)
    .set({ apiKeyHash: hashApiKey(rawKey) })
    .where(eq(schema.agents.id, agentId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_key_rotated",
    decision: "n/a",
    reason: `Merchant issued a new API key for agent "${existing.name}". The previous key stops working immediately.`,
  });

  return { agent, rawKey };
}

export async function revokeAgent(merchantId: string, agentId: string) {
  if (!agentId) throw new Error("Missing agentId");
  await requireOwnedAgent(merchantId, agentId);

  const [agent] = await db
    .update(schema.agents)
    .set({ status: "revoked" })
    .where(eq(schema.agents.id, agentId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_revoked",
    decision: "n/a",
    reason: `Merchant revoked agent "${agent.name}". It will be denied on its next transaction attempt.`,
  });

  return agent;
}

export async function reactivateAgent(merchantId: string, agentId: string) {
  if (!agentId) throw new Error("Missing agentId");
  await requireOwnedAgent(merchantId, agentId);

  const [agent] = await db
    .update(schema.agents)
    .set({ status: "active" })
    .where(eq(schema.agents.id, agentId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "agent_reactivated",
    decision: "n/a",
    reason: `Merchant reactivated agent "${agent.name}".`,
  });

  return agent;
}

/**
 * Connects (or replaces) a merchant's own Razorpay test-mode credentials.
 * Validates against Razorpay before writing anything, so a typo can't
 * strand the merchant with broken credentials overwriting working ones.
 */
export async function connectRazorpay(merchantId: string, keyId: string, keySecret: string) {
  if (!keyId.trim() || !keySecret.trim()) {
    throw new Error("Key ID and Key Secret are both required");
  }

  // Throws RazorpayCallError with Razorpay's own message on invalid
  // credentials — propagated as-is so the settings form can show it.
  await validateCredentials({ keyId, keySecret });

  await db
    .update(schema.merchants)
    .set({
      razorpayKeyIdEncrypted: encrypt(keyId),
      razorpayKeySecretEncrypted: encrypt(keySecret),
    })
    .where(eq(schema.merchants.id, merchantId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "razorpay_connected",
    decision: "n/a",
    reason: `Merchant connected a Razorpay account (key ending ...${keyId.slice(-4)}). Agents can now transact.`,
  });
}

/** Disconnects a merchant's Razorpay credentials. Every subsequent money action fails closed with the same reason as never-connected. */
export async function disconnectRazorpay(merchantId: string) {
  await db
    .update(schema.merchants)
    .set({ razorpayKeyIdEncrypted: null, razorpayKeySecretEncrypted: null })
    .where(eq(schema.merchants.id, merchantId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "razorpay_disconnected",
    decision: "n/a",
    reason: "Merchant disconnected their Razorpay account. Agents will be denied on their next transaction attempt until a new one is connected.",
  });
}

/** Loads a product and throws unless it belongs to the given merchant, so no mutation can act on another merchant's product by id alone. */
async function requireOwnedProduct(merchantId: string, productId: string) {
  const [product] = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.merchantId, merchantId)));

  if (!product) throw new Error("Product not found");
  return product;
}

/** Loads a variant and throws unless it belongs to the given merchant, so no mutation can act on another merchant's variant by id alone. */
async function requireOwnedVariant(merchantId: string, variantId: string) {
  const [variant] = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.id, variantId), eq(schema.productVariants.merchantId, merchantId)));

  if (!variant) throw new Error("Variant not found");
  return variant;
}

/** A short, human-distinguishable default SKU when a merchant doesn't give one — never a collision risk in practice, and the unique index catches the rare case. */
function generateDefaultSku(): string {
  return `SKU-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

export interface CreateProductInput {
  merchantId: string;
  name: string;
  description: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
  sku?: string;
}

/**
 * Creates a product with one default variant — the fast path for a
 * merchant selling one thing, which stays a single form submission rather
 * than forcing every merchant through a variant matrix (Layer 5-1). The
 * only way a product exists outside scripts/seed.ts.
 */
export async function createProduct(input: CreateProductInput) {
  if (!input.name.trim()) throw new Error("Product name is required");
  if (!Number.isInteger(input.stock) || input.stock < 0) {
    throw new Error("Stock must be a non-negative integer");
  }

  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId: input.merchantId,
      name: input.name.trim(),
      description: input.description.trim(),
      status: "active",
    })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: input.merchantId,
      sku: input.sku?.trim() || generateDefaultSku(),
      pricePaise: rupeesToPaise(input.priceRupees),
      costPaise: rupeesToPaise(input.costRupees),
      stock: input.stock,
      availability: input.stock > 0 ? "in_stock" : "out_of_stock",
      status: "active",
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "product_created",
    decision: "n/a",
    reason: `Merchant added "${product.name}" to the catalogue at ₹${input.priceRupees.toFixed(2)} (${input.stock} in stock, SKU ${variant.sku}).`,
  });

  return { product, variant };
}

export interface UpdateProductInput {
  merchantId: string;
  productId: string;
  variantId: string;
  name: string;
  description: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
  sku: string;
}

/** Edits a product's listing fields and its default variant. Never used to bypass the gate's atomic stock decrement — this sets an absolute stock count from the merchant, not a purchase-driven delta. */
export async function updateProduct(input: UpdateProductInput) {
  if (!input.name.trim()) throw new Error("Product name is required");
  if (!input.sku.trim()) throw new Error("SKU is required");
  if (!Number.isInteger(input.stock) || input.stock < 0) {
    throw new Error("Stock must be a non-negative integer");
  }

  const existing = await requireOwnedProduct(input.merchantId, input.productId);
  await requireOwnedVariant(input.merchantId, input.variantId);

  const [product] = await db
    .update(schema.products)
    .set({
      name: input.name.trim(),
      description: input.description.trim(),
    })
    .where(eq(schema.products.id, input.productId))
    .returning();

  const [variant] = await db
    .update(schema.productVariants)
    .set({
      sku: input.sku.trim(),
      pricePaise: rupeesToPaise(input.priceRupees),
      costPaise: rupeesToPaise(input.costRupees),
      stock: input.stock,
      availability: input.stock > 0 ? "in_stock" : "out_of_stock",
    })
    .where(eq(schema.productVariants.id, input.variantId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "product_updated",
    decision: "n/a",
    reason: `Merchant updated "${existing.name}" — price ₹${input.priceRupees.toFixed(2)}, stock ${input.stock}, SKU ${input.sku}.`,
  });

  return { product, variant };
}

export interface SetNegotiationFloorInput {
  merchantId: string;
  variantId: string;
  /** Null clears the floor — the variant becomes not negotiable, a real absence rather than a permissive default (see negotiation.ts). */
  floorPriceRupees: number | null;
  belowCostAcknowledged: boolean;
}

/**
 * Sets (or clears) one variant's negotiation floor (Layer 8) — the
 * merchant-authored minimum negotiate.ts's engine is bounded by. Setting
 * one below the variant's own costPaise requires explicit acknowledgment,
 * mirroring bundles.ts's createBundle belowCostAcknowledged discipline. A
 * floor above the catalogue price is rejected outright — "negotiate up"
 * is not a real request this feature serves.
 */
export async function setVariantNegotiationFloor(input: SetNegotiationFloorInput) {
  const variant = await requireOwnedVariant(input.merchantId, input.variantId);

  if (input.floorPriceRupees === null) {
    const [updated] = await db
      .update(schema.productVariants)
      .set({ floorPricePaise: null, belowCostFloorAcknowledged: false })
      .where(eq(schema.productVariants.id, input.variantId))
      .returning();

    await logAuditEntry({
      merchantId: input.merchantId,
      actor: "merchant",
      event: "negotiation_floor_cleared",
      decision: "n/a",
      reason: `Merchant made "${variant.sku}" not negotiable — cleared its floor price.`,
    });

    return updated;
  }

  const floorPricePaise = rupeesToPaise(input.floorPriceRupees);
  if (floorPricePaise <= 0) throw new Error("Floor price must be positive");

  if (floorPricePaise > variant.pricePaise) {
    throw new Error(
      `Floor price ₹${input.floorPriceRupees.toFixed(2)} is above "${variant.sku}"'s own catalogue price of ₹${(variant.pricePaise / 100).toFixed(2)}. A floor cannot exceed the listed price.`,
    );
  }

  if (floorPricePaise < variant.costPaise && !input.belowCostAcknowledged) {
    throw new Error(
      `Floor price ₹${input.floorPriceRupees.toFixed(2)} is below "${variant.sku}"'s cost of ₹${(variant.costPaise / 100).toFixed(2)}. Confirm to allow negotiating at a loss deliberately.`,
    );
  }

  const [updated] = await db
    .update(schema.productVariants)
    .set({ floorPricePaise, belowCostFloorAcknowledged: floorPricePaise < variant.costPaise })
    .where(eq(schema.productVariants.id, input.variantId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "negotiation_floor_set",
    decision: "n/a",
    reason: `Merchant set "${variant.sku}"'s negotiation floor to ₹${input.floorPriceRupees.toFixed(2)} (catalogue price ₹${(variant.pricePaise / 100).toFixed(2)}, max discount ${(100 - (floorPricePaise / variant.pricePaise) * 100).toFixed(0)}%)${updated.belowCostFloorAcknowledged ? ", below cost — acknowledged as a deliberate loss" : ""}.`,
  });

  return updated;
}

export interface AddVariantInput {
  merchantId: string;
  productId: string;
  sku?: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
  /** e.g. {"size": "250g"} — a merchant adding a second variant is almost always distinguishing it by something like this. Free text key/value, parsed at the form boundary. */
  attributeKey?: string;
  attributeValue?: string;
}

/**
 * Adds a second (or third, ...) variant to an existing product — the
 * multi-variant path createProduct's single-form fast path doesn't cover.
 * Same validation and audit discipline as createProduct; the only real
 * difference is this attaches to an existing productId instead of
 * creating one.
 */
export async function addVariant(input: AddVariantInput) {
  const product = await requireOwnedProduct(input.merchantId, input.productId);

  if (!Number.isInteger(input.stock) || input.stock < 0) {
    throw new Error("Stock must be a non-negative integer");
  }
  if (!Number.isFinite(input.priceRupees) || input.priceRupees <= 0) {
    throw new Error("Price must be positive");
  }

  const attributes: Record<string, string> =
    input.attributeKey?.trim() && input.attributeValue?.trim() ? { [input.attributeKey.trim()]: input.attributeValue.trim() } : {};

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: input.merchantId,
      sku: input.sku?.trim() || generateDefaultSku(),
      pricePaise: rupeesToPaise(input.priceRupees),
      costPaise: rupeesToPaise(input.costRupees),
      stock: input.stock,
      availability: input.stock > 0 ? "in_stock" : "out_of_stock",
      attributes,
      status: "active",
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "variant_added",
    decision: "n/a",
    reason: `Merchant added a new variant to "${product.name}": SKU ${variant.sku}, ₹${input.priceRupees.toFixed(2)}, ${input.stock} in stock${Object.keys(attributes).length > 0 ? ` (${Object.entries(attributes).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}.`,
  });

  return variant;
}

export interface UpdateVariantInput {
  merchantId: string;
  variantId: string;
  sku: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
  attributeKey?: string;
  attributeValue?: string;
}

/** Edits one variant directly — the multi-variant counterpart to updateProduct's combined product+variant form, used once a product has more than its original default variant. Never used to bypass the gate's atomic stock decrement — this sets an absolute stock count from the merchant, not a purchase-driven delta. */
export async function updateVariant(input: UpdateVariantInput) {
  if (!input.sku.trim()) throw new Error("SKU is required");
  if (!Number.isInteger(input.stock) || input.stock < 0) {
    throw new Error("Stock must be a non-negative integer");
  }

  await requireOwnedVariant(input.merchantId, input.variantId);

  const attributes: Record<string, string> =
    input.attributeKey?.trim() && input.attributeValue?.trim() ? { [input.attributeKey.trim()]: input.attributeValue.trim() } : {};

  const [variant] = await db
    .update(schema.productVariants)
    .set({
      sku: input.sku.trim(),
      pricePaise: rupeesToPaise(input.priceRupees),
      costPaise: rupeesToPaise(input.costRupees),
      stock: input.stock,
      availability: input.stock > 0 ? "in_stock" : "out_of_stock",
      attributes,
    })
    .where(eq(schema.productVariants.id, input.variantId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "variant_updated",
    decision: "n/a",
    reason: `Merchant updated variant "${input.sku}" — price ₹${input.priceRupees.toFixed(2)}, stock ${input.stock}.`,
  });

  return variant;
}

/** Archives a single variant without touching the rest of the product's variants or the product itself — the multi-variant counterpart to archiveProduct. A product with zero active variants simply stops appearing in the catalogue (getPublicCatalogue already filters empty-variant products), without needing to also archive the product row. */
export async function archiveVariant(merchantId: string, variantId: string) {
  const variant = await requireOwnedVariant(merchantId, variantId);

  const [updated] = await db
    .update(schema.productVariants)
    .set({ status: "archived" })
    .where(eq(schema.productVariants.id, variantId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "variant_archived",
    decision: "n/a",
    reason: `Merchant archived variant "${variant.sku}". It no longer appears in the catalogue or accepts purchases.`,
  });

  return updated;
}

/** Reactivates a single archived variant. */
export async function reactivateVariant(merchantId: string, variantId: string) {
  const variant = await requireOwnedVariant(merchantId, variantId);

  const [updated] = await db
    .update(schema.productVariants)
    .set({ status: "active" })
    .where(eq(schema.productVariants.id, variantId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "variant_reactivated",
    decision: "n/a",
    reason: `Merchant reactivated variant "${variant.sku}".`,
  });

  return updated;
}

/** Archives a product and every one of its variants rather than deleting them — past money_actions rows keep their reference, and archived products/variants stop appearing in the catalogue or accepting purchases. */
export async function archiveProduct(merchantId: string, productId: string) {
  const existing = await requireOwnedProduct(merchantId, productId);

  const [product] = await db
    .update(schema.products)
    .set({ status: "archived" })
    .where(eq(schema.products.id, productId))
    .returning();

  await db
    .update(schema.productVariants)
    .set({ status: "archived" })
    .where(eq(schema.productVariants.productId, productId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "product_archived",
    decision: "n/a",
    reason: `Merchant archived "${existing.name}". It no longer appears in the catalogue or accepts purchases.`,
  });

  return product;
}

export interface SetMerchantPolicyInput {
  merchantId: string;
  returnsAccepted: boolean;
  returnWindowDays: number | null;
  refundMethod: (typeof schema.refundMethodEnum.enumValues)[number] | null;
  restockingFeePercent: number | null;
  shippingRegions: string[];
  handlingTimeDays: number | null;
  warrantyMonths: number | null;
  policyNotes: string;
}

/**
 * Writes the merchant's structured return/refund/shipping terms (Layer
 * 5-3) — an upsert, since every merchant starts with no row here and that
 * is an honest "not published" state, not a permissive default (see
 * DECISIONS.md). Fields not accepting returns implies (returnWindowDays,
 * refundMethod null) are cleared rather than left stale.
 */
export async function setMerchantPolicy(input: SetMerchantPolicyInput) {
  if (input.restockingFeePercent !== null && (input.restockingFeePercent < 0 || input.restockingFeePercent > 100)) {
    throw new Error("Restocking fee percent must be between 0 and 100");
  }

  const values = {
    merchantId: input.merchantId,
    returnsAccepted: input.returnsAccepted,
    returnWindowDays: input.returnsAccepted ? input.returnWindowDays : null,
    refundMethod: input.returnsAccepted ? input.refundMethod : null,
    restockingFeePercent: input.restockingFeePercent,
    shippingRegions: input.shippingRegions,
    handlingTimeDays: input.handlingTimeDays,
    warrantyMonths: input.warrantyMonths,
    policyNotes: input.policyNotes.trim() || null,
    updatedAt: new Date(),
  };

  const [existing] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, input.merchantId));

  const policy = existing
    ? (await db.update(schema.merchantPolicies).set(values).where(eq(schema.merchantPolicies.merchantId, input.merchantId)).returning())[0]
    : (await db.insert(schema.merchantPolicies).values(values).returning())[0];

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "merchant_policy_updated",
    decision: "n/a",
    reason: input.returnsAccepted
      ? `Merchant published a return policy: ${input.returnWindowDays ?? "?"}-day window, refund via ${input.refundMethod ?? "unspecified"}.`
      : "Merchant set their policy to not accepting returns.",
  });

  return policy;
}

/** Reactivates a previously archived product and its variants. */
export async function reactivateProduct(merchantId: string, productId: string) {
  const existing = await requireOwnedProduct(merchantId, productId);

  const [product] = await db
    .update(schema.products)
    .set({ status: "active" })
    .where(eq(schema.products.id, productId))
    .returning();

  await db
    .update(schema.productVariants)
    .set({ status: "active" })
    .where(eq(schema.productVariants.productId, productId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "product_reactivated",
    decision: "n/a",
    reason: `Merchant reactivated "${existing.name}".`,
  });

  return product;
}

export interface SetRewardSettingsInput {
  merchantId: string;
  paisePerCoinRupees: number;
  issueRatePermille: number;
  maxRedemptionPercent: number;
}

/**
 * Writes the merchant's reward-coin program bounds (Layer 6-5) — an
 * upsert, since no row means rewards are simply off (see
 * merchant_reward_settings' schema comment). Every field here is
 * integer arithmetic the gate/reward-coins.ts later trusts unchanged, so
 * validation happens once, here, at the write boundary.
 */
export async function setRewardSettings(input: SetRewardSettingsInput) {
  if (!Number.isFinite(input.paisePerCoinRupees) || input.paisePerCoinRupees <= 0) {
    throw new Error("Paise per coin must be a positive amount");
  }
  if (!Number.isInteger(input.issueRatePermille) || input.issueRatePermille < 0 || input.issueRatePermille > 1000) {
    throw new Error("Issue rate must be an integer per-mille between 0 and 1000");
  }
  if (!Number.isInteger(input.maxRedemptionPercent) || input.maxRedemptionPercent < 0 || input.maxRedemptionPercent > 100) {
    throw new Error("Max redemption percent must be an integer between 0 and 100");
  }

  const values = {
    merchantId: input.merchantId,
    paisePerCoin: rupeesToPaise(input.paisePerCoinRupees),
    issueRatePermille: input.issueRatePermille,
    maxRedemptionPercent: input.maxRedemptionPercent,
    updatedAt: new Date(),
  };

  const [existing] = await db.select().from(schema.merchantRewardSettings).where(eq(schema.merchantRewardSettings.merchantId, input.merchantId));

  const settings = existing
    ? (await db.update(schema.merchantRewardSettings).set(values).where(eq(schema.merchantRewardSettings.merchantId, input.merchantId)).returning())[0]
    : (await db.insert(schema.merchantRewardSettings).values(values).returning())[0];

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "reward_settings_updated",
    decision: "n/a",
    reason: `Merchant set reward coins to ₹${input.paisePerCoinRupees.toFixed(2)}/coin, issuing ${(input.issueRatePermille / 10).toFixed(1)}% of a captured purchase's value in coins, redeemable up to ${input.maxRedemptionPercent}% of any single purchase.`,
  });

  return settings;
}

/**
 * Layer 11-6: which merchant digest alert types are on. Not a money
 * action — no gate, no bound, just a preference — so no audit entry;
 * matches the "n/a" treatment other pure-preference mutations already
 * get in this file. Absence of a row means every type defaults to on
 * (merchantAlertSettings' own schema comment), so an upsert here is
 * only needed the first time a merchant actually changes something.
 */
export async function updateAlertSettings(
  merchantId: string,
  values: {
    escalationPendingEnabled: boolean;
    holdExpiringEnabled: boolean;
    notificationExhaustedEnabled: boolean;
    webhookExhaustedEnabled: boolean;
  },
) {
  const [settings] = await db
    .insert(schema.merchantAlertSettings)
    .values({ merchantId, ...values })
    .onConflictDoUpdate({ target: schema.merchantAlertSettings.merchantId, set: { ...values, updatedAt: new Date() } })
    .returning();

  return settings;
}

/**
 * Layer 11-8: creates one AI-credit tier — a real Groq model id under
 * its real display name, and a merchant-set integer coin price. Coin
 * pricing is a merchant decision, never a model's — same discipline
 * setRewardSettings above already applies to the coin-to-paise rate.
 */
export async function createAiCreditTier(input: { merchantId: string; modelId: string; displayName: string; provider: string; coinsPerRequest: number }) {
  if (!Number.isInteger(input.coinsPerRequest) || input.coinsPerRequest <= 0) {
    throw new Error("Coin price must be a positive integer.");
  }

  const [tier] = await db
    .insert(schema.aiCreditTiers)
    .values({
      merchantId: input.merchantId,
      modelId: input.modelId,
      displayName: input.displayName,
      provider: input.provider,
      coinsPerRequest: input.coinsPerRequest,
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "ai_credit_tier_created",
    decision: "n/a",
    reason: `Added AI credit tier "${input.displayName}" (${input.modelId}) at ${input.coinsPerRequest} coins per response.`,
  });

  return tier;
}

export async function setAiCreditTierEnabled(merchantId: string, tierId: string, enabled: boolean) {
  const [tier] = await db
    .update(schema.aiCreditTiers)
    .set({ enabled })
    .where(and(eq(schema.aiCreditTiers.id, tierId), eq(schema.aiCreditTiers.merchantId, merchantId)))
    .returning();

  if (!tier) throw new Error("Tier not found.");

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: enabled ? "ai_credit_tier_enabled" : "ai_credit_tier_disabled",
    decision: "n/a",
    reason: `${enabled ? "Enabled" : "Disabled"} AI credit tier "${tier.displayName}".`,
  });

  return tier;
}
