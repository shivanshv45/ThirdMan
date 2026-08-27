import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * All money columns are integer paise (₹1 = 100 paise). Never floats.
 * All timestamps are UTC. All primary keys are UUIDs.
 */

export const agentStatusEnum = pgEnum("agent_status", ["active", "revoked"]);

export const spendCapStatusEnum = pgEnum("spend_cap_status", [
  "active",
  "exhausted",
  "expired",
  "revoked",
]);

export const moneyActionTypeEnum = pgEnum("money_action_type", [
  "order_create",
  "capture",
  "refund",
  "payout",
  "reward_issue",
  "reward_redeem",
]);

export const moneyActionStatusEnum = pgEnum("money_action_status", [
  "allowed",
  "denied",
  "executed",
  "held",
  "captured",
  "failed",
  "pending_escalation",
]);

export const escalationOutcomeEnum = pgEnum("escalation_outcome", [
  "pending",
  "approved",
  "rejected",
]);

export const auditActorEnum = pgEnum("audit_actor", [
  "agent",
  "customer",
  "merchant",
  "system",
]);

export const auditDecisionEnum = pgEnum("audit_decision", [
  "allow",
  "deny",
  "escalate",
  "n/a",
]);

export const productStatusEnum = pgEnum("product_status", [
  "active",
  "archived",
]);

export const productCategoryEnum = pgEnum("product_category", [
  "food_beverage",
  "apparel",
  "electronics",
  "home_goods",
  "beauty_personal_care",
  "health_wellness",
  "books_media",
  "toys_games",
  "sporting_goods",
  "office_supplies",
  "other",
]);

export const variantAvailabilityEnum = pgEnum("variant_availability", [
  "in_stock",
  "out_of_stock",
  "preorder",
  "discontinued",
]);

export const refundMethodEnum = pgEnum("refund_method", [
  "original_payment_method",
  "store_credit",
  "either",
]);

export const escrowHoldOutcomeEnum = pgEnum("escrow_hold_outcome", [
  "held",
  "captured",
  "refunded",
  "expired_refunded",
]);

export const paymentFailureSourceEnum = pgEnum("payment_failure_source", [
  "webhook",
  "simulated",
]);

export const paymentFailureStatusEnum = pgEnum("payment_failure_status", [
  "new",
  "diagnosed",
  "recovering",
  "recovered",
  "written_off",
]);

export const recoveryStrategyEnum = pgEnum("recovery_strategy", [
  "retry_same_instrument",
  "alternate_instrument",
  "payment_link_nudge",
  "human_escalation",
  "write_off",
]);

export const recoveryOutcomeEnum = pgEnum("recovery_outcome", [
  "pending",
  "succeeded",
  "failed",
  "abandoned",
]);

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // scrypt hash, stored as "salt:hash" hex. Never a raw password.
  passwordHash: text("password_hash").notNull(),
  // AES-256-GCM ciphertext of the merchant's own Razorpay test credentials.
  // Null until the merchant connects their account (Layer 2-2). Format:
  // "iv:tag:ciphertext", base64 segments. Decrypted only in src/lib/crypto.ts.
  razorpayKeyIdEncrypted: text("razorpay_key_id_encrypted"),
  razorpayKeySecretEncrypted: text("razorpay_key_secret_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A logged-in merchant session. DB-backed rather than a JWT so a session
// can be revoked by deleting the row (password change, logout-everywhere).
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The marketing-level entity (Layer 5-1): title, description, category —
// what a merchant thinks of as "a product." Money and stock now live on
// product_variants, since a real product (a coffee bag in 250g/1kg, a mug
// in three colours) is rarely one sellable unit. A product with exactly
// one variant is still the common case and the dashboard's default path.
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  // A small closed set, not free text — what makes cross-merchant
  // comparison possible at all (prd.md §1 idea #6, not built yet, but the
  // enum is the seam it would attach to).
  category: productCategoryEnum("category").notNull().default("other"),
  subcategory: text("subcategory"),
  // Archived products keep their history (past money_actions rows still
  // reference their variants) but don't appear in the catalogue or accept
  // new purchases. Never hard-delete a product — see setSpendCap's
  // precedent of revoke-don't-delete for agent keys (Layer 2-3).
  status: productStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A sellable unit of a product (Layer 5-1) — its own SKU, price, cost,
// stock, and attributes. The gate's productId bound (Layer 4-1) now
// resolves and reserves against this table, not products directly.
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    // Denormalised from products.merchantId so SKU uniqueness can be
    // enforced per merchant without a join, and so every gate/agent-facing
    // query that's naturally merchant-scoped doesn't need one either.
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    // Stable, merchant-meaningful identifier. Unique per merchant — what an
    // agent references in a reorder, not this row's own UUID.
    sku: text("sku").notNull(),
    pricePaise: integer("price_paise").notNull(),
    // What margin-aware decisions in later layers (upsell, negotiation) read.
    // Never exposed on any agent-facing or public shape.
    costPaise: integer("cost_paise").notNull(),
    // Written exclusively by the gate, via the same atomic conditional-
    // UPDATE pattern spend_caps.spentPaise already uses.
    stock: integer("stock").notNull(),
    // Derived from stock where possible, but a merchant can override —
    // "discontinued" is information an agent needs that a zero stock count
    // alone doesn't convey.
    availability: variantAvailabilityEnum("availability").notNull().default("in_stock"),
    // Flat string->string map only, e.g. {"size": "250g", "roast": "light"}.
    // Never nested — validated at the write boundary, not by the column
    // type, so it stays machine-comparable.
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    // Optional global identifiers. Empty for most merchants — only useful
    // once cross-merchant product matching exists, which it doesn't yet.
    gtin: text("gtin"),
    mpn: text("mpn"),
    // A URL only. No image upload/hosting — see DECISIONS.md.
    imageUrl: text("image_url"),
    status: productStatusEnum("status").notNull().default("active"),
    // Layer 8: the merchant's stated minimum unit price for negotiation.
    // Null means this variant is not negotiable at all — a real absence,
    // never a default that silently permits negotiation (same discipline
    // as merchant_policies/merchant_reward_settings having no row at all
    // meaning "off"). Deliberately a merchant-authored price, not derived
    // from costPaise at negotiation time — see DECISIONS.md, "The
    // negotiation floor is a merchant-authored price, not a margin."
    floorPricePaise: integer("floor_price_paise"),
    // True only if the merchant explicitly acknowledged floorPricePaise
    // sits below costPaise — mirrors bundles.belowCostAcknowledged.
    belowCostFloorAcknowledged: boolean("below_cost_floor_acknowledged").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("product_variants_merchant_sku_idx").on(table.merchantId, table.sku)],
);

// An external AI buyer authorised to transact against this merchant.
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name").notNull(),
  // Hash of the agent's API key. The raw key is never stored.
  apiKeyHash: text("api_key_hash").notNull().unique(),
  status: agentStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The bound. Models UPI Reserve Pay: authorise once, spend within a
// window, up to a total and a per-transaction ceiling.
export const spendCaps = pgTable("spend_caps", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  capPaise: integer("cap_paise").notNull(),
  // Running total spent within the current window. Only the gate module
  // (Layer 1) may write this column, and only via an atomic conditional update.
  spentPaise: integer("spent_paise").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  perTransactionMaxPaise: integer("per_transaction_max_paise").notNull(),
  status: spendCapStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Every attempt to move value, allowed or denied.
export const moneyActions = pgTable(
  "money_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    // Nullable: human-initiated actions (e.g. merchant-approved escalation)
    // have no originating agent.
    agentId: uuid("agent_id").references(() => agents.id),
    // Nullable: escrow, recovery retries, and payouts aren't tied to one
    // product. Kept after Layer 5-1's variant migration so past rows keep
    // pointing at a valid product without repurposing this column —
    // variantId (below) is what a Layer 5+ purchase actually resolves and
    // reserves against.
    productId: uuid("product_id").references(() => products.id),
    // The specific variant purchased (Layer 5-1). Nullable for the same
    // reasons as productId, and additionally null on every pre-Layer-5 row.
    variantId: uuid("variant_id").references(() => productVariants.id),
    quantity: integer("quantity").notNull().default(1),
    // True only for the escrow hold-and-capture flow (Layer 4-5): the
    // Razorpay order is created with payment_capture: false, so a
    // successful checkout leaves the payment authorized, not captured.
    // Read at capture-confirmation time to know whether a verified
    // payment should transition this row to "held" or straight to
    // "captured".
    holdOnly: boolean("hold_only").notNull().default(false),
    type: moneyActionTypeEnum("type").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: moneyActionStatusEnum("status").notNull(),
    // The Razorpay order id, set once createOrder succeeds (status: executed).
    razorpayEntityId: text("razorpay_entity_id"),
    // The Razorpay payment id that actually paid this order, set once a
    // capture is confirmed (checkout signature or webhook) or a held
    // payment is captured (escrow). Needed separately from
    // razorpayEntityId (the order id) because capturePayment/refundPayment
    // operate on a payment id, not an order id.
    razorpayPaymentId: text("razorpay_payment_id"),
    // Agent-supplied idempotency key. Null for actions not requested
    // through the idempotent agent API (e.g. merchant-approved escalations).
    // Unique per agent, so a repeat request with the same key is
    // recognised and answered from the stored outcome rather than
    // re-running the gate.
    idempotencyKey: text("idempotency_key"),
    // Layer 6: when a purchase references an accepted upsell offer, the
    // gate resolves the discount from this row's bundle, never from
    // anything the caller asserted (see gate.ts's resolveOffer). New
    // column, never repurposing productId/variantId — same discipline
    // Layer 5-1 used adding variantId. References offers, declared later
    // in this file — drizzle resolves table references lazily via
    // closures, so the forward reference is fine.
    offerId: uuid("offer_id").references((): typeof offers.id => offers.id),
    // Layer 8: when a purchase redeems an agreed negotiated price, the
    // gate resolves the amount from this row, never from anything the
    // caller asserted (see gate.ts's resolveNegotiation). New column,
    // never repurposing productId/variantId/offerId — same discipline
    // Layer 5-1 and Layer 6-1 both used. Forward reference via a closure,
    // same as offerId above — negotiations is declared later in this file.
    negotiationId: uuid("negotiation_id").references((): typeof negotiations.id => negotiations.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("money_actions_agent_idempotency_key_idx")
      .on(table.agentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

// A money action the risk layer flagged instead of executing. Reserved
// budget stays held until a merchant approves or rejects it.
export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  moneyActionId: uuid("money_action_id")
    .notNull()
    .references(() => moneyActions.id),
  spendCapId: uuid("spend_cap_id")
    .notNull()
    .references(() => spendCaps.id),
  riskReason: text("risk_reason").notNull(),
  outcome: escalationOutcomeEnum("outcome").notNull().default("pending"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A held payment (Layer 4-5's escrow demo): authorized but not captured,
// visible and resolvable from the dashboard rather than only inferred
// from Razorpay's own state — an unreleasable hold nobody can see is a
// support ticket waiting to happen. expiresAt is the deterministic bound
// that stops a hold from stranding a buyer's money indefinitely; a
// scheduled sweep (or the dashboard's own load, whichever runs first)
// auto-refunds anything past its expiry.
export const escrowHolds = pgTable("escrow_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  moneyActionId: uuid("money_action_id")
    .notNull()
    .references(() => moneyActions.id),
  outcome: escrowHoldOutcomeEnum("outcome").notNull().default("held"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The narrative record. One row per decision. `reason` is the field a
// judge reads, so it must be a sentence explaining why, not a status code.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Every entry belongs to exactly one merchant, independent of whether
  // it's linked to a money action. Required so a denial logged before a
  // money_actions row exists (or a merchant-account event like signup)
  // never leaks into another merchant's audit trail.
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  // Nullable: not every logged decision moves money (e.g. a denial before
  // any money_actions row would make sense to create).
  moneyActionId: uuid("money_action_id").references(() => moneyActions.id),
  actor: auditActorEnum("actor").notNull(),
  event: text("event").notNull(),
  decision: auditDecisionEnum("decision").notNull(),
  reason: text("reason").notNull(),
  // Which bound was evaluated and its state at decision time, e.g.
  // "spend_cap:<id> remaining ₹400 of ₹1000". Null when no bound applies.
  boundApplied: text("bound_applied"),
  // Never write secrets, full card data, or full PII into this column.
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per Razorpay webhook event actually processed, keyed by
// Razorpay's own event id (the `x-razorpay-event-id` header). Razorpay
// redelivers on a missed 200, and a payment.captured/order.paid delivered
// twice must not double-capture, double-decrement stock, or double-log —
// this is the equivalent of payment_failures' partial unique index,
// generalised to every webhook event type, not just failures.
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  razorpayEventId: text("razorpay_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per payment that did not succeed. `source` distinguishes a real
// webhook delivery from a merchant-loaded demo batch — display only, the
// recovery pipeline must never branch on it (see plans/layer-3-recovery-pipeline.md).
export const paymentFailures = pgTable(
  "payment_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    razorpayOrderId: text("razorpay_order_id"),
    razorpayPaymentId: text("razorpay_payment_id"),
    amountPaise: integer("amount_paise").notNull(),
    // Razorpay's own code, verbatim. Never normalised on write — diagnose.ts
    // owns interpreting it.
    declineCode: text("decline_code").notNull(),
    declineDescription: text("decline_description"),
    // An opaque handle only. Never an email, phone, or name — this row
    // feeds the audit log, and CLAUDE.md rule 1 bars full PII there.
    customerRef: text("customer_ref"),
    source: paymentFailureSourceEnum("source").notNull(),
    status: paymentFailureStatusEnum("status").notNull().default("new"),
    diagnosis: jsonb("diagnosis"),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Razorpay redelivers webhooks. Without this, a redelivery creates a
    // second failure row and double-counts recovered revenue.
    uniqueIndex("payment_failures_merchant_payment_idx")
      .on(table.merchantId, table.razorpayPaymentId)
      .where(sql`${table.razorpayPaymentId} is not null`),
  ],
);

// One row per recovery attempt the pipeline makes against a failure.
export const recoveryAttempts = pgTable("recovery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentFailureId: uuid("payment_failure_id")
    .notNull()
    .references(() => paymentFailures.id),
  // 1-based. Enforced by the sequencer, part of the MAX_ATTEMPTS_PER_FAILURE
  // stopping rule in policy.ts.
  attemptNumber: integer("attempt_number").notNull(),
  strategy: recoveryStrategyEnum("strategy").notNull(),
  // Non-null only for strategies that moved money — the proof this
  // attempt actually passed through the gate, not a bypass.
  moneyActionId: uuid("money_action_id").references(() => moneyActions.id),
  // Set for retry_same_instrument/alternate_instrument/payment_link_nudge
  // (Layer 4-3) — a real, payable Razorpay Payment Link. The webhook's
  // payment_link.paid handler matches back on razorpayPaymentLinkId to
  // verify and set recoveredPaise; never trusted before that.
  razorpayPaymentLinkId: text("razorpay_payment_link_id"),
  paymentLinkUrl: text("payment_link_url"),
  outcome: recoveryOutcomeEnum("outcome").notNull().default("pending"),
  // A full sentence, same standard as audit_log.reason — this is what a
  // merchant reads to understand why the agent did what it did.
  reason: text("reason").notNull(),
  // Only ever non-zero when outcome is "succeeded", and only ever set from
  // a verified Razorpay result, never optimistically from an order being
  // created. Keeping this the sole source other columns are zero makes
  // double-counting recovered revenue structurally impossible.
  recoveredPaise: integer("recovered_paise").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const chatMessageRoleEnum = pgEnum("chat_message_role", ["customer", "assistant"]);

// The buyer chat's conversation state (Layer 4-6), keyed by a browser-
// generated token rather than any account — the storefront has no
// buyer login. The cart lives here as productId/quantity, computed and
// owned entirely by code: the model never sets these columns directly,
// only ever reads them back to describe the cart in conversation. See
// CLAUDE.md rule 2 — the LLM does discovery, never arithmetic or price.
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  sessionToken: text("session_token").notNull().unique(),
  cartProductId: uuid("cart_product_id").references(() => products.id),
  // The specific variant selected (Layer 5-7) — nullable for the same
  // reason as money_actions.variantId: a pre-Layer-5-7 conversation row
  // has a product but no resolved variant. When set, this (not
  // cartProductId) is what price/stock/checkout actually resolve against.
  cartVariantId: uuid("cart_variant_id").references(() => productVariants.id),
  cartQuantity: integer("cart_quantity").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per chat turn. content is the only field the model ever
// writes freely (a customer's message, or the assistant's natural-
// language reply) — any price or total the assistant states in content
// must already have been computed in code and handed to it as a fact,
// never computed by the model itself (see src/lib/chat.ts).
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: chatMessageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Structured, machine-readable merchant terms (Layer 5-3). Every field
// here is what an agent parses; policyNotes is the one field that's ever
// free text, and it's for the human reading it, never the field an agent
// acts on. A merchant with no row here has genuinely not published a
// policy — see DECISIONS.md on why there is no fabricated permissive
// default.
export const merchantPolicies = pgTable("merchant_policies", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  returnsAccepted: boolean("returns_accepted").notNull().default(false),
  returnWindowDays: integer("return_window_days"),
  refundMethod: refundMethodEnum("refund_method"),
  // Integer percent, 0-100. Never a float near money.
  restockingFeePercent: integer("restocking_fee_percent"),
  shippingRegions: text("shipping_regions").array().notNull().default(sql`'{}'::text[]`),
  handlingTimeDays: integer("handling_time_days"),
  warrantyMonths: integer("warranty_months"),
  policyNotes: text("policy_notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const catalogueImportSourceEnum = pgEnum("catalogue_import_source", ["csv", "pasted_text"]);

export const catalogueImportStatusEnum = pgEnum("catalogue_import_status", [
  "previewed",
  "imported",
  "failed",
]);

// One row per import run (Layer 5-2) — CSV upload or a pasted-text blob
// the model structured. Written once the merchant confirms the preview
// and rows are actually written; a "previewed" row that's never confirmed
// is not persisted here (nothing to show a merchant about an import that
// never happened). rowCounts is a small summary object, not a copy of
// every row — the imported rows themselves are the product_variants they
// created or updated.
export const catalogueImports = pgTable("catalogue_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  source: catalogueImportSourceEnum("source").notNull(),
  status: catalogueImportStatusEnum("status").notNull().default("imported"),
  rowsParsed: integer("rows_parsed").notNull(),
  rowsImported: integer("rows_imported").notNull(),
  rowsSkipped: integer("rows_skipped").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 6: upsell, bundling, cashback rewards (§5) ---

export const offerStatusEnum = pgEnum("offer_status", [
  "offered",
  "accepted",
  "declined",
  "expired",
]);

// A merchant-authored discount definition (Layer 6-1). The ONLY source of
// truth for a discounted amount — a caller can reference a bundle by id,
// never assert its own discounted price. See gate.ts's resolveOffer and
// DECISIONS.md: this exists so the gate's product_price_match bound never
// has to be weakened for a discount to be honoured.
export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name").notNull(),
  status: productStatusEnum("status").notNull().default("active"),
  // The bundle's total price, integer paise, merchant-set. Never derived
  // from a percent at read time — one stable number an offer references.
  bundlePricePaise: integer("bundle_price_paise").notNull(),
  // True only if the merchant explicitly acknowledged bundlePricePaise
  // falls below the summed costPaise of its items. Deterministic-code
  // checked at creation time (dashboard-mutations.ts), never inferred
  // later — see DECISIONS.md, "a merchant may genuinely want a
  // loss-leader."
  belowCostAcknowledged: boolean("below_cost_acknowledged").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The variants (and their quantities) a bundle contains. A bundle needs
// at least one item — enforced in code at creation, not by the schema.
export const bundleItems = pgTable("bundle_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  bundleId: uuid("bundle_id")
    .notNull()
    .references(() => bundles.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariants.id),
  quantity: integer("quantity").notNull().default(1),
});

// One row per offer the engine actually presented to a buyer (Layer
// 6-2/6-4) — never written for a run that produced no offer at all; that
// case is offer_decisions below. expiresAt is a real, code-checked
// deterministic bound, not decorative "limited time" copy — see
// resolveOffer in gate.ts.
export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  bundleId: uuid("bundle_id")
    .notNull()
    .references(() => bundles.id),
  // Nullable: an offer can be made to an authenticated agent or to an
  // anonymous storefront/chat session — never both, enforced in code.
  agentId: uuid("agent_id").references(() => agents.id),
  sessionToken: text("session_token"),
  status: offerStatusEnum("status").notNull().default("offered"),
  // The one-sentence explanation the model produced, shown to the buyer
  // and kept for the audit/offer trail. Never contains a margin or cost
  // figure — see cost-paise-never-leaks.test.ts.
  reasonText: text("reason_text").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The offer/refusal log (Layer 6-4) — one row per engine run, whether or
// not it produced an offer. This is deliberately NOT audit_log: no money
// moved yet at decision time, and overloading the money audit trail with
// non-money events would make it harder to read for the thing it's
// actually for. offeredOfferId is set only when the run resulted in an
// offer (see offers above); a null offeredOfferId with a non-null
// noOfferReason is the refusal case prd.md §7 idea #1 is about —
// eligibleCandidateCount and belowMarginFloorCount let a merchant (or a
// judge) see the exact arithmetic that produced the refusal.
export const offerDecisions = pgTable("offer_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  agentId: uuid("agent_id").references(() => agents.id),
  sessionToken: text("session_token"),
  cartVariantId: uuid("cart_variant_id").references(() => productVariants.id),
  eligibleCandidateCount: integer("eligible_candidate_count").notNull(),
  belowMarginFloorCount: integer("below_margin_floor_count").notNull(),
  offeredOfferId: uuid("offered_offer_id").references(() => offers.id),
  noOfferReason: text("no_offer_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rewardLedgerReasonEnum = pgEnum("reward_ledger_reason", [
  "purchase_issue",
  "redemption",
]);

// The reward-coin ledger (Layer 6-5) — append-only, integer coins, never
// a mutable balance column. A balance is the sum of this table's deltas
// for a customer, same reasoning as recoveredPaise living on the
// attempt rather than the failure (DECISIONS.md): one number derived
// from evidence, not two that can diverge. Every row traces back to a
// settled money_actions row via moneyActionId — see gate.ts's
// executeAndSettle reward branch. Coins are never paise; conversion
// happens only in reward-coins.ts's deterministic rate arithmetic.
// Merchant-set reward program bounds (Layer 6-5). No row means the
// merchant hasn't turned rewards on — same "absence is real, not a
// permissive default" discipline as merchant_policies (DECISIONS.md).
export const merchantRewardSettings = pgTable("merchant_reward_settings", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  // Integer paise per coin — the sole conversion rate, merchant-set.
  // coinsToIssue = floor(capturedAmountPaise * issueRatePermille / 1000 / paisePerCoin);
  // redemptionValuePaise = coins * paisePerCoin. Both integer arithmetic,
  // rounding direction fixed in reward-coins.ts, never a float.
  paisePerCoin: integer("paise_per_coin").notNull(),
  // Coins issued per 1000 paise captured (a permille rate keeps the whole
  // computation in integers — e.g. 50 = 5% of the captured amount, in
  // coin-equivalent value).
  issueRatePermille: integer("issue_rate_permille").notNull(),
  // Integer percent 0-100: the maximum share of a single purchase
  // payable in redeemed coins.
  maxRedemptionPercent: integer("max_redemption_percent").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rewardCoinLedger = pgTable("reward_coin_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  // Nullable like offers.agentId/sessionToken: whichever identity earned
  // or spent the coins, never both.
  agentId: uuid("agent_id").references(() => agents.id),
  sessionToken: text("session_token"),
  // Positive on issue, negative on redemption. Never zero — a
  // zero-coin ledger entry documents nothing and is rejected in code.
  coinsDelta: integer("coins_delta").notNull(),
  reason: rewardLedgerReasonEnum("reason").notNull(),
  moneyActionId: uuid("money_action_id")
    .notNull()
    .references(() => moneyActions.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 8: bounded autonomous negotiation (§4) ---

// Only "refused_turns_exhausted" is ever actually reached — a
// negotiation only fails once the buyer's counters run out while still
// below the floor; there is no separate "floor breached but turns
// remain" terminal state, since submitBuyerCounter always offers another
// counter round rather than giving up early. A second, distinct
// "refused_floor" value was considered and dropped before any row ever
// used it (verified live against the real DB) — see DECISIONS.md.
export const negotiationStatusEnum = pgEnum("negotiation_status", [
  "open",
  "agreed",
  "refused_turns_exhausted",
  "expired",
  "redeemed",
]);

export const negotiationTurnSpeakerEnum = pgEnum("negotiation_turn_speaker", ["buyer", "merchant_agent"]);

// A negotiation is, itself, the artifact a purchase redeems once it
// reaches "agreed" — there is no separate "agreed price" table, since an
// agreed negotiation IS a merchant-authored price at that point, the same
// way an accepted offers row IS a redeemable discount (DECISIONS.md,
// "How an agreed negotiated price is represented"). agreedPricePaise is
// null until status transitions to "agreed" and is never written any
// other way — see negotiation.ts's concedeOrAgree.
export const negotiations = pgTable("negotiations", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariants.id),
  quantity: integer("quantity").notNull().default(1),
  // Nullable like offers.agentId/sessionToken: whichever identity is
  // negotiating, never both — enforced in code.
  agentId: uuid("agent_id").references(() => agents.id),
  sessionToken: text("session_token"),
  status: negotiationStatusEnum("status").notNull().default("open"),
  // The catalogue price at negotiation start — the ceiling every counter
  // and concession is measured against, frozen at open time so a
  // mid-negotiation price change on the variant can't retroactively
  // change what's being negotiated.
  catalogueUnitPricePaise: integer("catalogue_unit_price_paise").notNull(),
  // The floor this negotiation is bound by, copied from the variant's
  // floorPricePaise at open time for the same freezing reason as
  // catalogueUnitPricePaise — never re-read from product_variants after
  // opening, so a merchant changing the floor mid-negotiation can't move
  // the goalposts on an already-open one.
  floorUnitPricePaise: integer("floor_unit_price_paise").notNull(),
  // The most recent price on the table from each side, per unit. Updated
  // every turn by negotiation.ts, never by a caller directly.
  currentBuyerOfferPaise: integer("current_buyer_offer_paise"),
  currentMerchantCounterPaise: integer("current_merchant_counter_paise"),
  // Only set once status = "agreed" — see the table comment above.
  agreedUnitPricePaise: integer("agreed_unit_price_paise"),
  buyerTurnCount: integer("buyer_turn_count").notNull().default(0),
  // A real, code-checked deterministic bound — an agreed price can't be
  // redeemed, and an open negotiation can't be continued, once this
  // passes. Same discipline as offers.expiresAt.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per exchange — the transcript a merchant reads end to end.
// Cannot live in audit_log: logAuditEntry never throws into a money path
// and a failed write is swallowed (audit.ts), so it's not a reliable home
// for a record that must be reconstructable turn-by-turn.
export const negotiationTurns = pgTable("negotiation_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  negotiationId: uuid("negotiation_id")
    .notNull()
    .references(() => negotiations.id),
  speaker: negotiationTurnSpeakerEnum("speaker").notNull(),
  // Null on a merchant_agent turn generated by the deterministic-degrade
  // path (no model call made) — see negotiation.ts's fail-closed comment.
  offeredUnitPricePaise: integer("offered_unit_price_paise"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
