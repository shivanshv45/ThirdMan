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

export interface CreateProductInput {
  merchantId: string;
  name: string;
  description: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
}

/** Creates a product in the merchant's own catalogue. The only way a product exists outside scripts/seed.ts. */
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
      pricePaise: rupeesToPaise(input.priceRupees),
      costPaise: rupeesToPaise(input.costRupees),
      stock: input.stock,
      status: "active",
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "product_created",
    decision: "n/a",
    reason: `Merchant added "${product.name}" to the catalogue at ₹${input.priceRupees.toFixed(2)} (${input.stock} in stock).`,
  });

  return product;
}

export interface UpdateProductInput {
  merchantId: string;
  productId: string;
  name: string;
  description: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
}

/** Edits a product's listing fields. Never used to bypass the gate's atomic stock decrement — this sets an absolute stock count from the merchant, not a purchase-driven delta. */
export async function updateProduct(input: UpdateProductInput) {
  if (!input.name.trim()) throw new Error("Product name is required");
  if (!Number.isInteger(input.stock) || input.stock < 0) {
    throw new Error("Stock must be a non-negative integer");
  }

  const existing = await requireOwnedProduct(input.merchantId, input.productId);

  const [product] = await db
    .update(schema.products)
    .set({
      name: input.name.trim(),
      description: input.description.trim(),
      pricePaise: rupeesToPaise(input.priceRupees),
      costPaise: rupeesToPaise(input.costRupees),
      stock: input.stock,
    })
    .where(eq(schema.products.id, input.productId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "product_updated",
    decision: "n/a",
    reason: `Merchant updated "${existing.name}" — price ₹${input.priceRupees.toFixed(2)}, stock ${input.stock}.`,
  });

  return product;
}

/** Archives a product rather than deleting it — past money_actions rows keep their reference, and archived products stop appearing in the catalogue or accepting purchases. */
export async function archiveProduct(merchantId: string, productId: string) {
  const existing = await requireOwnedProduct(merchantId, productId);

  const [product] = await db
    .update(schema.products)
    .set({ status: "archived" })
    .where(eq(schema.products.id, productId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "product_archived",
    decision: "n/a",
    reason: `Merchant archived "${existing.name}". It no longer appears in the catalogue or accepts purchases.`,
  });

  return product;
}

/** Reactivates a previously archived product. */
export async function reactivateProduct(merchantId: string, productId: string) {
  const existing = await requireOwnedProduct(merchantId, productId);

  const [product] = await db
    .update(schema.products)
    .set({ status: "active" })
    .where(eq(schema.products.id, productId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "product_reactivated",
    decision: "n/a",
    reason: `Merchant reactivated "${existing.name}".`,
  });

  return product;
}
