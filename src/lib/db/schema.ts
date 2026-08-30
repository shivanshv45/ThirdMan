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
  index,
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
  // Null for a merchant who has only ever signed in via OAuth (Layer 12) —
  // they simply have no email/password form to use until they set one.
  passwordHash: text("password_hash"),
  // AES-256-GCM ciphertext of the merchant's own Razorpay test credentials.
  // Null until the merchant connects their account (Layer 2-2). Format:
  // "iv:tag:ciphertext", base64 segments. Decrypted only in src/lib/crypto.ts.
  razorpayKeyIdEncrypted: text("razorpay_key_id_encrypted"),
  razorpayKeySecretEncrypted: text("razorpay_key_secret_encrypted"),
  // Layer 13-3: the merchant's own ECDSA P-256 signing key for AP2
  // Checkout Mandates. Both nullable — generated lazily on first mandate
  // use (mandates.ts's getOrCreateMandateKeypair), so an existing
  // merchant is unaffected until they actually transact with mandates.
  // Private key AES-256-GCM encrypted at rest, same crypto.ts helper and
  // format as the Razorpay credentials above. Public key stored
  // plaintext — any counterparty must be able to verify a signature
  // without a secret.
  mandateSigningKeyEncrypted: text("mandate_signing_key_encrypted"),
  mandatePublicKey: text("mandate_public_key"),
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

export const oauthProviderEnum = pgEnum("oauth_provider", ["google", "github"]);

// One row per (provider, provider's own account id) linked to a merchant.
// A merchant can have at most one linked identity per provider — re-linking
// the same provider account updates this row (onConflictDoUpdate on the
// same unique index) rather than creating a duplicate. email is a snapshot
// at link time, not kept in sync with the provider afterward.
export const oauthIdentities = pgTable(
  "oauth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    provider: oauthProviderEnum("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("oauth_identities_provider_account_idx").on(table.provider, table.providerAccountId)],
);

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

// L21-8: provisional, self-registered agents are ordinary agents rows —
// this is metadata about HOW one came to exist, not a separate trust
// tier or code path. registeredIp is kept for the rate-limit/abuse
// story, not displayed as PII anywhere merchant-facing beyond the agents
// list already showing it.
export const agentRegistrationSourceEnum = pgEnum("agent_registration_source", ["merchant_issued", "self_registered"]);

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
  // Layer 13-3: opt-in per agent, so existing demo flows keep working
  // while the mandate path is exercised — false means purchase requests
  // from this agent need no mandate at all (today's behavior, unchanged).
  // A merchant flips this on per-agent once satisfied with the flow.
  mandateRequired: boolean("mandate_required").notNull().default(false),
  // Layer 23-3: a running count of catalogue reads (list_products/
  // get_product/search_products/check_availability, both the REST route
  // and their MCP equivalents), incremented atomically alongside every
  // real call — see agent-auth.ts's recordCatalogueRead(). Paired with
  // money_actions' own per-agent count to compute a read-to-purchase
  // ratio: information a merchant can act on (revoke a key, tighten
  // capabilities), never a bound a model or this column enforces on its
  // own. A running counter, not a rolling window, because the ratio is
  // read relative to money_actions' timestamped rows, which already
  // give a real window to compare against.
  catalogueReadCount: integer("catalogue_read_count").notNull().default(0),
  // Layer 21-8: how this agent's row came to exist. Every agent before
  // this layer, and every one a merchant creates by hand afterward, is
  // "merchant_issued" — the default preserves that without a backfill.
  // "self_registered" agents are otherwise ordinary rows: same enum,
  // same capabilities table, same spend_caps shape, same gate path.
  registrationSource: agentRegistrationSourceEnum("registration_source").notNull().default("merchant_issued"),
  // Only set for self_registered agents — the registering caller's IP,
  // kept for abuse investigation (alongside rate-limit.ts's own
  // per-IP/per-merchant limiting), never shown as a general agent
  // attribute anywhere prices or capabilities are displayed.
  registeredIp: text("registered_ip"),
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
    // Layer 9-close-out: a genuine multi-item cart purchase (multiple
    // distinct variants, one order). Set together with a
    // cart_purchase_items snapshot (below) recording exactly which
    // variant/quantity/price lines this money action covers — cart_items
    // itself is live and mutable (a buyer can keep shopping after
    // checking out), so a money_actions row must never point at it
    // directly; it needs its own frozen record of what was actually
    // bought, the same reason negotiations freezes catalogueUnitPricePaise
    // at open time instead of re-reading product_variants later.
    cartId: uuid("cart_id").references((): typeof cartPurchases.id => cartPurchases.id),
    // Layer 23-2: set only at the moment a reservation is taken (status
    // "allowed", right before executeAndSettle runs), to
    // now() + RESERVATION_TIMEOUT_MINUTES. Cleared (set back to null) the
    // instant executeAndSettle resolves the row to "executed"/"held"/
    // "failed" — a null value means "nothing to sweep," never "no
    // deadline." This is what catches the gap executeAndSettle's own
    // try/catch cannot: a process crash (serverless timeout, OOM, a
    // deploy restart) between the reservation and the Razorpay call,
    // which leaves budget and stock held with no in-process catch block
    // left to run. sweepAbandonedReservations() in gate.ts is the release
    // path, following the same "a hold left indefinitely is money in
    // limbo" reasoning escrow_holds.expiresAt already established.
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    // Layer 21-4: set when this money action was taken under a
    // successfully verified AP2 Payment Mandate — the caller
    // (agent/purchase route, the MCP purchase tool) verifies the mandate
    // BEFORE calling attemptMoneyAction and passes the consumed mandate's
    // own id through, never re-derived here. Null is the common case
    // today (mandates are opt-in) and must always be shown as "no
    // mandate," never as an ambiguous or silently-verified state — see
    // explainability.ts and DECISIONS.md.
    checkoutMandateId: uuid("checkout_mandate_id").references((): typeof checkoutMandates.id => checkoutMandates.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("money_actions_agent_idempotency_key_idx")
      .on(table.agentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    // Partial index backing sweepAbandonedReservations' query — only
    // "allowed" rows ever carry a non-null reservationExpiresAt, so this
    // index stays small regardless of total money_actions volume.
    index("money_actions_reservation_expiry_idx")
      .on(table.reservationExpiresAt)
      .where(sql`${table.status} = 'allowed' and ${table.reservationExpiresAt} is not null`),
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
  // Set deterministically at creation (see gate.ts's escalation insert):
  // createdAt + merchant_policies.escalationWindowHours, or a 48h default
  // matching escrow's ESCROW_HOLD_EXPIRY_HOURS shape (Layer 11). Past
  // this, escalations:expire (notifications/expiry.ts) resolves the
  // escalation as "rejected" via gate.ts's own resolveEscalation — never
  // a second, duplicate release path — so timing out denies, it never
  // auto-approves. Fail closed: silence is not consent.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    // Nullable — a webhook-sourced failure often has no address at all,
    // and that is a normal state, not an error (Layer 11). Set from the
    // Razorpay payload if present, or added later by a merchant on
    // /dashboard/recovery. See contacts.ts and recovery/sequencer.ts.
    customerContactId: uuid("customer_contact_id").references(() => customerContacts.id),
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
  // Layer 11-5: set (deterministically, by chat.ts) the turn a customer
  // is offered a restock alert for an out-of-stock variant; cleared the
  // moment they either provide an address or move on to something else.
  // Not inferred from chat history — a real pointer, same "written
  // exclusively by code, never the model" discipline as cartItems above.
  pendingRestockVariantId: uuid("pending_restock_variant_id").references(() => productVariants.id),
  // Layer 18: set (deterministically, by chat.ts's provide_contact
  // handling, via contacts.ts's recordContact) the moment a real email
  // is on file for this session — what makes a customer_contact memory
  // subject reachable at all. Same "written exclusively by code, never
  // the model" discipline as pendingRestockVariantId above. Null means
  // this session is genuinely anonymous and gets no memory.
  customerContactId: uuid("customer_contact_id").references(() => customerContacts.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The buyer chat's cart (Layer 9-close-out: replaces the single-line
// cartProductId/cartVariantId/cartQuantity columns previously on
// conversations). One row per distinct variant in the cart — a real
// multi-item cart, not the single-line placeholder Layer 5-7 shipped.
// Written exclusively by code (src/lib/chat.ts's applyIntent), never
// directly by the model, same discipline the single-line columns had.
// Deleting a row (quantity reaches 0, or the item is explicitly removed)
// is how a line leaves the cart — there is no "quantity: 0" row state.
export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("cart_items_conversation_variant_idx").on(table.conversationId, table.variantId)],
);

// A frozen snapshot of a cart at the moment a purchase was attempted
// through the gate (Layer 9-close-out) — referenced by
// money_actions.cartId. cart_items itself is live (the buyer can keep
// shopping after checkout), so this is what "what did money_actions row
// X actually buy" resolves against, permanently, the same freezing
// reason negotiations copies catalogueUnitPricePaise at open time rather
// than re-reading product_variants later.
export const cartPurchases = pgTable("cart_purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cartPurchaseItems = pgTable("cart_purchase_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  cartPurchaseId: uuid("cart_purchase_id")
    .notNull()
    .references(() => cartPurchases.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariants.id),
  quantity: integer("quantity").notNull(),
  // The catalogue price at the moment of purchase, frozen here for the
  // same reason every other snapshot in this schema freezes a price —
  // product_variants.pricePaise can change after this row is written.
  unitPricePaise: integer("unit_price_paise").notNull(),
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

// ---------------------------------------------------------------------
// Layer 10 — the embeddable widget. A second front door onto the exact
// same buyer endpoints /store/[merchantId] already calls (see
// ARCHITECTURE.md's "The embeddable widget"). Introduces no new money
// action type and no new gate path.
// ---------------------------------------------------------------------

export const embedStatusEnum = pgEnum("embed_status", ["active", "disabled"]);

export const embedPositionEnum = pgEnum("embed_position", [
  "bottom_right",
  "bottom_left",
]);

// One config per merchant, same shape as merchant_policies — merchantId
// is the primary key, not a separate id, since there is never more than
// one.
export const embedConfigs = pgTable("embed_configs", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  // "pk_<base64url>", stored in PLAINTEXT deliberately — unlike
  // agents.apiKeyHash, this value is printed verbatim into public HTML
  // by design, so hashing it buys nothing, and storing it plainly is
  // what lets the dashboard show a merchant their own key again after a
  // reload (the opposite of the agent-key "shown once" contract in
  // agent-key-reveal.tsx). Never accept an "sk_"-prefixed value here —
  // see embed.ts's resolveEmbedKey.
  publishableKey: text("publishable_key").notNull().unique(),
  status: embedStatusEnum("status").notNull().default("active"),
  // Normalised (scheme+host+port, lowercased host, no trailing slash)
  // exact-match origins — see embed.ts's normalizeOrigin. Empty means
  // "not configured yet", enforced as a deny by isOriginAllowed, never
  // as "allow everything" (fail closed, same discipline as every other
  // bound in this codebase).
  allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
  // Cosmetic only — what the embedded widget's header/greeting show.
  // Null falls back to merchants.name / the existing default copy.
  displayName: text("display_name"),
  // Validated as a hex colour (#rgb or #rrggbb) before it is ever
  // stored or interpolated into CSS — see embed.ts's isValidHexColor.
  // A merchant-supplied string reaching a stylesheet unvalidated is a
  // CSS injection.
  accentColor: text("accent_color"),
  greeting: text("greeting"),
  position: embedPositionEnum("position").notNull().default("bottom_right"),
  // Real on/off switches for features that already exist elsewhere in
  // the product (negotiation, offers) — never a flag for behaviour that
  // isn't built.
  features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookStatusEnum = pgEnum("webhook_status", ["active", "disabled"]);

// A merchant-registered endpoint their own backend exposes to receive
// server-to-server notifications (order.paid, stock.changed, ...) —
// the same idea as Razorpay's own webhook to this app, mirrored one
// level down. Unlike embedConfigs.publishableKey, `secret` genuinely is
// a secret (it signs every delivery) and is encrypted at rest via
// crypto.ts, same as merchants.razorpayKeySecretEncrypted.
export const merchantWebhooks = pgTable("merchant_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  url: text("url").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  subscribedEvents: text("subscribed_events").array().notNull().default(sql`'{}'::text[]`),
  status: webhookStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
  "exhausted",
]);

// The durable outbound queue. A row exists BEFORE any HTTP call is
// attempted (see webhooks/enqueue.ts) — that is what makes a crashed
// process recoverable rather than a silently dropped notification.
// Never delivered synchronously from a money-moving code path: enqueue
// is fast and can't fail the caller; delivery happens out-of-band via
// webhooks/runner.ts, exactly the separation gate.ts keeps between
// checkBounds (decide) and executeAndSettle (carry out).
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Denormalised from merchantWebhooks so the dashboard's delivery-log
    // query is one join fewer.
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => merchantWebhooks.id),
    eventType: text("event_type").notNull(),
    // Exactly the bytes signed and sent — see webhooks/deliver.ts. Never
    // re-serialised at send time, same discipline webhook-verify.ts's
    // own docstring establishes for inbound Razorpay signatures.
    payload: jsonb("payload").notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    // When the next retry becomes due. Null once delivered or exhausted.
    // The runner's only query predicate for "what's due right now".
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    // Nullable: stock.changed events aren't tied to one purchase.
    moneyActionId: uuid("money_action_id").references(() => moneyActions.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // confirmCapture has two independent success paths (checkout
    // signature, webhook) that can both fire for one capture — this
    // makes "enqueue the order.paid notification" idempotent at the
    // database level rather than hoping the race doesn't happen. See
    // the gate contract's point 10; that race is documented as normal.
    uniqueIndex("webhook_deliveries_dedupe_idx")
      .on(table.webhookId, table.eventType, table.moneyActionId)
      .where(sql`${table.moneyActionId} is not null`),
  ],
);

// --- Layer 11: notifications, contactable customers, token rewards ---
// See plans/layer-11-notifications-and-token-rewards.md. This is a
// separate delivery spine from webhook_deliveries above: that one
// notifies a merchant's SERVER (machine-to-machine, HMAC-signed,
// SSRF is the risk); this one notifies a HUMAN (consent and
// unsubscribe are mandatory, no signing needed). Same durable-queue
// shape, deliberately not merged — see DECISIONS.md.

export const contactChannelEnum = pgEnum("contact_channel", ["email"]);

export const contactConsentSourceEnum = pgEnum("contact_consent_source", [
  "checkout",
  "chat_restock_request",
  "recovery_intake",
  "merchant_entered",
]);

// A customer's contact address, with consent provenance and an
// unsubscribe token from birth — every row, no exceptions, even though
// a recovery-link email arguably wouldn't strictly need one. See L11-1.
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    channel: contactChannelEnum("channel").notNull().default("email"),
    // Normalised lowercase — see contacts.ts's normalizeEmail. Never
    // stored as typed.
    address: text("address").notNull(),
    consentSource: contactConsentSourceEnum("consent_source").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Opaque, unguessable, generated once at insert and NEVER rotated —
    // an unsubscribe link already sent in an email must keep working.
    // This token is the sole credential on the public unsubscribe route.
    unsubscribeToken: text("unsubscribe_token").notNull().unique(),
    // Non-null means: send nothing to this contact, ever, regardless of
    // what triggers a later enqueue. Checked by contacts.ts's
    // isContactable, called from exactly one place (the queue's
    // enqueue path) so there is never a second opinion.
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One contact row per address per merchant — a customer who both
    // fails a payment and later asks for a restock alert is ONE row
    // with one unsubscribe token, not two, so unsubscribing from one
    // context can't leave the other still sending.
    uniqueIndex("customer_contacts_merchant_channel_address_idx").on(
      table.merchantId,
      table.channel,
      table.address,
    ),
  ],
);

export const recipientKindEnum = pgEnum("recipient_kind", ["customer", "merchant"]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "exhausted",
  "suppressed",
]);

// The durable outbound queue for human-facing notifications. A row
// exists BEFORE any provider call is attempted (see
// notifications/enqueue.ts) — same "crash mid-flight leaves a
// traceable row" discipline as money_actions and webhook_deliveries.
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    // Nullable: a merchant-addressed alert (L11-6) goes to
    // merchants.email, which already exists and needs no contact row.
    contactId: uuid("contact_id").references(() => customerContacts.id),
    recipientKind: recipientKindEnum("recipient_kind").notNull(),
    // e.g. "recovery_link" | "restock_alert" | "escalation_pending" |
    // "hold_expiring" | "notification_exhausted" | "webhook_exhausted".
    // Not an enum: notifications/policy.ts owns the closed list of valid
    // values in code, where the frequency-cap and dedupe logic already
    // has to reason about them; a DB enum here would just be a second
    // place to keep in sync.
    notificationType: text("notification_type").notNull(),
    channel: contactChannelEnum("channel").notNull().default("email"),
    subject: text("subject").notNull(),
    // Exactly what was sent, plain text — same discipline as
    // webhook_deliveries.payload storing the exact signed bytes. A
    // delivery log that can't show what a customer actually received
    // isn't evidence.
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    status: notificationStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    // Nullable; set when the notification concerns a specific money
    // action (e.g. a recovery link), so the audit trail can join back.
    moneyActionId: uuid("money_action_id").references(() => moneyActions.id),
    // Nullable; the payment_failures/escrow_holds/escalations/variant
    // row this notification is about. Not a typed FK — it points at
    // different tables depending on notificationType, same "opaque
    // handle, interpreted by code, not the schema" choice as
    // payment_failures.customerRef.
    relatedEntityId: uuid("related_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Prevents the same notification being sent twice about the same
    // thing to the same person — e.g. a recovery sequencer run twice,
    // or two overlapping cron ticks both scanning for restocks. A
    // database constraint, not a hope that ticks never overlap. Same
    // trick as money_actions.idempotencyKey and
    // webhook_deliveries_dedupe_idx.
    uniqueIndex("notification_deliveries_dedupe_idx")
      .on(table.notificationType, table.relatedEntityId, table.contactId)
      .where(sql`${table.relatedEntityId} is not null`),
  ],
);

export const restockRequestStatusEnum = pgEnum("restock_request_status", [
  "waiting",
  "notified",
  "cancelled",
]);

// A buyer's "tell me when this is back" ask from the chat widget
// (L11-5). Deterministically scanned for by a cron job, never hooked
// on every stock write — stock changes in several places (gate
// reservation, release, merchant edit, import) and hooking all of them
// is how one gets missed. One scan over real current state can't drift.
export const restockRequests = pgTable(
  "restock_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => customerContacts.id),
    status: restockRequestStatusEnum("status").notNull().default("waiting"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (table) => [
    // A customer can only be "waiting" once per variant — asking twice
    // doesn't create two rows, and once notified they must ask again
    // (status becomes terminal) rather than being silently re-armed.
    uniqueIndex("restock_requests_waiting_idx")
      .on(table.variantId, table.contactId)
      .where(sql`${table.status} = 'waiting'`),
  ],
);

// --- Layer 11-8: reward coins redeemable for AI usage on this platform ---
// The tiers are real Groq-served models, honestly labelled — see
// ai-credits.ts's docstring and DECISIONS.md for why a Groq response is
// never relabelled under another vendor's model name. Reuses the same
// reward_coin_ledger every other coin issuance/redemption writes to
// (reason: "redemption") — this is not a second currency, it's a
// second thing the existing coins can buy.

// One row per model tier a merchant has configured. Seeded with real
// Groq model ids; a tier for a provider with no key configured is
// still a real row (enabled: false), shown in the UI as "not
// connected" rather than omitted or faked as available.
export const aiCreditTiers = pgTable("ai_credit_tiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  // The real provider model id passed to llm.ts, e.g.
  // "llama-3.3-70b-versatile" — never a fabricated or relabelled name.
  modelId: text("model_id").notNull(),
  // What the UI shows — must name the real model, not a stand-in for
  // another vendor's product.
  displayName: text("display_name").notNull(),
  provider: text("provider").notNull(),
  // Merchant-set integer coin price per request. Code multiplies;
  // never a model's call to make (CLAUDE.md rule 2).
  coinsPerRequest: integer("coins_per_request").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per AI-credit redemption. providerServed is what makes the
// tier-label honesty claim checkable by a test rather than asserted in
// a comment — see ai-credits.test.ts.
export const aiCreditRedemptions = pgTable("ai_credit_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  tierId: uuid("tier_id")
    .notNull()
    .references(() => aiCreditTiers.id),
  agentId: uuid("agent_id").references(() => agents.id),
  sessionToken: text("session_token"),
  coinsSpent: integer("coins_spent").notNull(),
  // The reward_coin_ledger row this redemption's coin deduction wrote —
  // same "trace back to real ledger evidence" discipline as
  // rewardCoinLedger.moneyActionId.
  rewardLedgerId: uuid("reward_ledger_id")
    .notNull()
    .references(() => rewardCoinLedger.id),
  promptExcerpt: text("prompt_excerpt").notNull(),
  responseExcerpt: text("response_excerpt"),
  // Which provider actually answered (llm.ts's own CompletionResult
  // field) — never assumed from the tier's displayName.
  providerServed: text("provider_served"),
  succeeded: boolean("succeeded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 11-6: merchant digest alerts ---
// One row per merchant, same "absence means default, not a magic
// fallback value" discipline as merchant_reward_settings — a merchant
// with no row here gets every alert type ON (default true), because a
// merchant who never opens the dashboard is exactly who this feature
// is for; explicitly turning one off writes a real row.
export const merchantAlertSettings = pgTable("merchant_alert_settings", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  escalationPendingEnabled: boolean("escalation_pending_enabled").notNull().default(true),
  holdExpiringEnabled: boolean("hold_expiring_enabled").notNull().default(true),
  notificationExhaustedEnabled: boolean("notification_exhausted_enabled").notNull().default(true),
  webhookExhaustedEnabled: boolean("webhook_exhausted_enabled").notNull().default(true),
  // Layer 26-3: a burst of failed logins on one of this merchant's
  // accounts crossing the free-attempts threshold — see login-throttle.ts.
  loginBurstEnabled: boolean("login_burst_enabled").notNull().default(true),
  // Layer 22: a return request awaiting the merchant's decision.
  returnPendingEnabled: boolean("return_pending_enabled").notNull().default(true),
  // When the last digest was actually sent — the dedupe bound for "at
  // most one digest per merchant per day" (notifications/merchant-
  // alerts.ts), read instead of relying on notification_deliveries'
  // own relatedEntityId dedupe (a digest has no single related entity;
  // it summarises several).
  lastDigestSentAt: timestamp("last_digest_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 13: authorization, supervision, and proof ---
// See plans/layer-13-authorization-supervision-proof.md. Three additions
// to the trust core: capability scoping (authentication is not
// authorization), AP2 mandate verification (proof a human authorized
// this specific checkout), and the Runtime Guardian (is this agent
// behaving normally right now). None of this replaces gate.ts's existing
// bound arithmetic — every check here composes BEFORE checkBounds runs.

// L13-2: a closed set of capabilities, queryable and constrained by the
// database rather than a jsonb blob a caller could shape freely. Refunds
// and payouts are deliberately NOT in this enum at all — no agent can
// ever hold them, a stronger statement than granting-then-revoking. See
// DECISIONS.md.
export const agentCapabilityEnum = pgEnum("agent_capability", [
  "products:read",
  "policy:read",
  "offers:read",
  "rewards:read",
  "rewards:redeem",
  "negotiation:create",
  "purchase:create",
]);

// One row per (agent, capability) granted. A capability not present here
// is denied — deny by default, same discipline as merchant_policies'
// "absence is real, not a permissive default." Existing agents are
// backfilled at migration time with the set matching what they could
// already do (see drizzle/0023's data migration), never left empty.
export const agentCapabilities = pgTable(
  "agent_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    capability: agentCapabilityEnum("capability").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("agent_capabilities_agent_capability_idx").on(table.agentId, table.capability)],
);

// L13-3: AP2 mandate verification. A documented subset — the Checkout
// Mandate and Payment Mandate verification path, as ES256-signed JWTs —
// not the full W3C Verifiable Credential / SD-JWT stack. See
// DECISIONS.md for the scoping and mandates.ts for why ECDSA P-256, not
// Ed25519 (the AP2 spec forbids a deterministic signature scheme here:
// it would enable rainbow-table attacks against checkout_hash).

export const checkoutMandateStatusEnum = pgEnum("checkout_mandate_status", [
  "issued",
  "consumed",
  "expired",
]);

// One row per Checkout JWT the merchant has signed for an agent's cart.
// jwt is the exact signed token — verification always re-derives
// checkoutHash from THIS value, never trusts a caller-supplied hash.
// status transitions issued -> consumed exactly once (replay
// protection — see mandates.ts's verifyPaymentMandate) or -> expired on
// a stale redemption attempt.
export const checkoutMandates = pgTable("checkout_mandates", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  jwt: text("jwt").notNull(),
  // SHA-256 of jwt, hex — stored so a Payment Mandate's own checkout_hash
  // claim can be compared without re-hashing the JWT on every lookup.
  checkoutHash: text("checkout_hash").notNull(),
  totalPaise: integer("total_paise").notNull(),
  status: checkoutMandateStatusEnum("status").notNull().default("issued"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mandateVerificationOutcomeEnum = pgEnum("mandate_verification_outcome", [
  "verified",
  "failed",
]);

// Every verification attempt, pass or fail — the evidence a merchant (or
// a judge) reads to see exactly which deterministic check ran and what
// it found. Mirrors offer_decisions' "one row per run, not just per
// success" discipline.
export const mandateVerifications = pgTable("mandate_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  checkoutMandateId: uuid("checkout_mandate_id").references(() => checkoutMandates.id),
  outcome: mandateVerificationOutcomeEnum("outcome").notNull(),
  // Which of the six deterministic steps failed, e.g.
  // "checkout_hash_mismatch" | "signature_invalid" | "expired" |
  // "already_consumed" | "amount_mismatch" | "constraint_violated".
  // Free text, not an enum — mandates.ts owns the closed list in code,
  // the same choice notification_deliveries.notificationType makes.
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// L13-4: the Runtime Guardian. Supervision — is this agent behaving
// normally right now — computed entirely from tables this codebase
// already owns (money_actions, audit_log, ai_credit_redemptions). No new
// telemetry source, no model consulted: "is this anomalous" is
// arithmetic against a rolling baseline, never a judgment call.
export const guardianStateEnum = pgEnum("guardian_state", [
  "normal",
  "throttled",
  "suspended",
  "revoked",
]);

// Current state per agent — the row checkBounds reads to deny outright
// when an agent is suspended/revoked (see gate.ts's resolveGuardianBound).
// One row per agent, created lazily on first evaluation, "normal" until
// a real breach moves it.
export const agentGuardianState = pgTable("agent_guardian_state", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  state: guardianStateEnum("state").notNull().default("normal"),
  // The signal that most recently changed state, and its observed vs.
  // baseline value — what a merchant reads on the incident view without
  // having to reconstruct it from guardian_transitions.
  lastSignal: text("last_signal"),
  lastObservedValue: text("last_observed_value"),
  lastBaselineValue: text("last_baseline_value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Append-only history of every state change — the transcript a merchant
// reads to understand not just "suspended" but why, same reasoning
// negotiation_turns exists instead of relying on audit_log alone (a
// dedicated table survives even if a single audit write were ever
// dropped, and is the natural home for a strictly ordered transcript).
export const guardianTransitions = pgTable("guardian_transitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  fromState: guardianStateEnum("from_state").notNull(),
  toState: guardianStateEnum("to_state").notNull(),
  // Which signal triggered this transition, e.g. "denied_ratio" |
  // "retry_count" | "escalation_rate" | "transaction_velocity" |
  // "ai_spend_rate" | "merchant_rearm". Free text, not an enum — same
  // reasoning as mandateVerifications.failureReason.
  triggerSignal: text("trigger_signal").notNull(),
  observedValue: text("observed_value").notNull(),
  baselineValue: text("baseline_value"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 14: the AI Treasury and the economic loop ---
// See plans/layer-14-ai-treasury.md. A configurable slice of successful
// GMV funds a pool split three ways (buyer AI credits, merchant AI
// budget, reserve). This is a demonstrated PRODUCT MECHANISM using this
// project's own simulation numbers, not a claim about Razorpay's real
// fee structure or economics — say so in the UI and in DECISIONS.md,
// never leave it implied.

// One row per merchant. Basis points (1/100 of a percent, 0-10000), not
// a float percentage — same "keep the whole computation in integers"
// reasoning as reward_coin_ledger's issueRatePermille. buyerShareBps +
// merchantShareBps + reserveShareBps must sum to exactly 10000 —
// enforced in code (treasury.ts), not a DB constraint, so the reason for
// a rejected configuration can be a readable sentence.
export const treasurySettings = pgTable("treasury_settings", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  // Share of captured GMV that enters the treasury at all, in basis
  // points of the captured amount (e.g. 500 = 5%).
  allocationBasisPoints: integer("allocation_basis_points").notNull(),
  // How the allocated contribution itself splits three ways, in basis
  // points of the CONTRIBUTION (not of GMV) — must sum to 10000.
  buyerShareBps: integer("buyer_share_bps").notNull(),
  merchantShareBps: integer("merchant_share_bps").notNull(),
  reserveShareBps: integer("reserve_share_bps").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const treasuryLedgerBucketEnum = pgEnum("treasury_ledger_bucket", [
  "buyer_credits",
  "merchant_ai_budget",
  "reserve",
]);

export const treasuryLedgerReasonEnum = pgEnum("treasury_ledger_reason", [
  // A captured payment funding the pool — always positive, always split
  // across all three buckets in the same transaction (treasury.ts's
  // fundTreasuryFromCapture).
  "capture_allocation",
  // A merchant AI operation drawing down its own budget bucket —
  // negative, wired in L14-4 (llm.ts routing) against real per-call
  // costs, never an estimate.
  "model_spend",
  // Buyer AI credits are the existing reward-coin system's concern once
  // issued — this reason marks the treasury-side debit that funded that
  // issuance, kept separate from reward_coin_ledger's own bookkeeping so
  // "what funded this reward" stays traceable without conflating two
  // different ledgers' balances.
  "buyer_credit_funding",
]);

// Append-only, mirrors reward_coin_ledger's own shape: balance per
// bucket is always SUM(amountPaise) for that (merchantId, bucket), never
// a mutable column — same "one number derived from evidence" discipline
// as every other ledger in this codebase. amountPaise is signed:
// positive on a capture funding the pool, negative on a draw.
export const treasuryLedger = pgTable(
  "treasury_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    bucket: treasuryLedgerBucketEnum("bucket").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    reason: treasuryLedgerReasonEnum("reason").notNull(),
    // The captured purchase that funded this row (capture_allocation) or
    // the spend it paid for (model_spend/buyer_credit_funding) — nullable
    // since not every draw traces to one specific money_actions row (a
    // model call charged against the merchant budget has no Razorpay
    // counterpart of its own).
    moneyActionId: uuid("money_action_id").references(() => moneyActions.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Dedupes a capture's allocation across the same race the reward-
    // coin ledger and webhook_deliveries both already guard against —
    // the checkout-signature path and the payment webhook can both
    // observe "allow" for the same capture. Partial: only
    // capture_allocation rows have exactly one row per (bucket,
    // moneyActionId); model_spend/buyer_credit_funding draws have no
    // such uniqueness requirement.
    uniqueIndex("treasury_ledger_capture_dedupe_idx")
      .on(table.bucket, table.moneyActionId)
      .where(sql`${table.reason} = 'capture_allocation'`),
  ],
);

// L14-2/L14-3: margin-aware reward multipliers, expressed as a small
// merchant-authored (or LLM-drafted, merchant-approved) rule AST rather
// than free-form logic. astJson is validated against reward-rules.ts's
// zod-defined grammar on every write — the DB column is jsonb but the
// application boundary is what makes it safe, same as
// productVariants.attributes. Evaluated deterministically at issue time
// (reward-rules.ts's evaluateRule) — an LLM only ever DRAFTS a
// candidate, never executes one; see DECISIONS.md, "zod AST over JSON
// Logic."
export const rewardRuleSourceEnum = pgEnum("reward_rule_source", [
  "merchant_authored",
  "llm_drafted",
]);

export const rewardRules = pgTable("reward_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  // What the merchant sees and approved — the compiled, human-readable
  // form of astJson, regenerated by code whenever astJson changes, never
  // hand-edited independently of it (so the two can never disagree).
  description: text("description").notNull(),
  astJson: jsonb("ast_json").notNull(),
  source: rewardRuleSourceEnum("source").notNull(),
  // An llm_drafted rule is inert (never evaluated) until a merchant
  // explicitly approves it — the plan's "an LLM-drafted rule never
  // activates unreviewed." merchant_authored rules are approved at
  // creation, since a merchant typing the rule directly into the form is
  // itself the approval.
  approved: boolean("approved").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  // Rules are tried in ascending priority order; the first whose
  // condition matches wins (reward-rules.ts's evaluateRules) — same
  // "first match wins, not all of them" discipline as
  // evaluateGuardianSignals's priority order.
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- L14-4: per-use-case AI model budgets, funded from the treasury's
// merchant_ai_budget bucket. A use case whose budget is exhausted
// degrades deterministically (routes to the cheapest tier, or refuses)
// — never silently overspends past its allocation.
export const modelUseCaseEnum = pgEnum("model_use_case", [
  "support_chat",
  "recovery_diagnosis",
  "negotiation",
  "classification",
]);

export const modelBudgets = pgTable(
  "model_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    useCase: modelUseCaseEnum("use_case").notNull(),
    // Integer-paise allocation for this use case, drawn from the
    // treasury's merchant_ai_budget bucket. Spend is derived as
    // SUM(amountPaise) of model_call_costs rows for this
    // (merchantId, useCase) since periodStart — never a mutable counter.
    budgetPaise: integer("budget_paise").notNull(),
    // Layer 16: which non-default provider this use case should route
    // to, when routing (not budget exhaustion) is the reason to leave
    // Groq — nullable, and null means "use the router's built-in
    // default for this use case" (model-router.ts), never "unroutable".
    // One attribute of an existing per-merchant, per-use-case row, not
    // a new table — there's exactly one decision to look up here.
    preferredProvider: text("preferred_provider"),
    periodStart: timestamp("period_start", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("model_budgets_merchant_use_case_idx").on(table.merchantId, table.useCase)],
);

// One row per real LLM call attributed to a use case — the evidence
// behind both budget-exhaustion checks and the routing-savings figure
// (L14-5's dashboard reads real per-call costPaise/premiumCostPaise,
// never an estimate rendered fresh each time). costPaise is what the
// tier actually selected would cost; premiumCostPaise is what the
// merchant's configured "premium" tier would have cost for the same
// call, computed the same deterministic way — the difference between
// the two sums is the real savings figure.
export const modelCallCosts = pgTable("model_call_costs", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  useCase: modelUseCaseEnum("use_case").notNull(),
  modelId: text("model_id").notNull(),
  provider: text("provider").notNull(),
  costPaise: integer("cost_paise").notNull(),
  premiumCostPaise: integer("premium_cost_paise").notNull(),
  // True if this call was served by the cheapest-tier fallback because
  // the use case's budget was exhausted (the demonstrable degrade-not-
  // overspend path) rather than by the router's normal selection.
  degraded: boolean("degraded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 17: the Agent Runtime ---
// See plans/layer-17-agent-runtime.md. Durable, resumable, long-running
// task execution as a Postgres-backed state machine advanced by
// /api/cron/run's existing tick — there is no worker process on this
// stack, so a task's state has to survive between ticks as rows, not as
// anything held in memory. Every money action a task takes still goes
// through attemptMoneyAction() under the task's own agentId — this
// schema adds no new authority, only a durable place to resume from.

export const agentTaskKindEnum = pgEnum("agent_task_kind", [
  "recovery_sequence",
]);

export const agentTaskStatusEnum = pgEnum("agent_task_status", [
  "pending",
  "claimed",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

// One row per unit of long-running work. "waiting" (correctly blocked
// until runAfter) is a distinct status from "pending" (ready to run
// now) on purpose — collapsing them loses the ability to tell a stalled
// task from a patient one on the merchant-facing task view.
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    // The identity this task acts under — every money action it takes is
    // this agent's action, bounded exactly as if the agent made the call
    // itself in a request (capability, Guardian state, spend cap, all of
    // it). Nullable only for a task kind that provably takes no money
    // action; runner.ts refuses to create a money-taking task with no
    // agent rather than defaulting to some implicit authority.
    agentId: uuid("agent_id").references(() => agents.id),
    kind: agentTaskKindEnum("kind").notNull(),
    status: agentTaskStatusEnum("status").notNull().default("pending"),
    // When this task next becomes eligible to be claimed — what makes
    // backoff and long waits expressible without a sleeping process.
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    // The claim lease — a task claimed past this timestamp is void and
    // reclaimable, so a process that dies mid-step doesn't strand the
    // task forever. Null when unclaimed.
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    // Task-specific progress, constrained by a zod schema per kind at
    // every read/write boundary (never trusted as-is) — same discipline
    // reward_rules.ts's AST column already uses for a jsonb column whose
    // shape must stay closed.
    state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Creating the same logical task twice (by idempotencyKey) yields
    // one runner, not two racing ones — scoped per merchant since a key
    // is only meaningful within one merchant's own task set.
    uniqueIndex("agent_tasks_merchant_idempotency_idx")
      .on(table.merchantId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

// Append-only — one row per attempted step, the task's own audit trail.
// What makes a task reconstructable after the fact, the same reasoning
// guardian_transitions and treasury_ledger are append-only rather than
// mutable columns.
export const agentTaskSteps = pgTable("agent_task_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => agentTasks.id),
  stepName: text("step_name").notNull(),
  outcome: text("outcome").notNull(), // "succeeded" | "failed" | "stopped" — free text, matching mandateVerifications.failureReason's own precedent for a small, code-owned vocabulary
  reason: text("reason").notNull(),
  // Set only when this step took a real money action — the proof this
  // step actually passed through the gate, not a bypass, same field
  // recovery_attempts.moneyActionId already plays for the recovery
  // pipeline this layer's first migration wraps.
  moneyActionId: uuid("money_action_id").references(() => moneyActions.id),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 18: the Memory Bank ---
// See plans/layer-18-memory-bank.md. The governing rule: memory is
// context, never a bound — gate.ts has no import of this table or of
// src/lib/memory/* at all. Anchored only to real, durable identities
// this product has (a customer contact, an agent) — never a session
// token or a fingerprint for an anonymous visitor.

export const memorySubjectTypeEnum = pgEnum("memory_subject_type", ["customer_contact", "agent"]);

export const memoryKindEnum = pgEnum("memory_kind", ["derived", "stated"]);

// One row per (subject, key) — update-in-place, not an append-only
// history. A correction replaces the value rather than sitting beside
// it, so retrieval can never surface two conflicting answers for the
// same key (see DECISIONS.md).
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    subjectType: memorySubjectTypeEnum("subject_type").notNull(),
    // Polymorphic by subjectType (customerContacts.id or agents.id) —
    // same documented-opaque-pointer discipline as
    // notificationDeliveries.relatedEntityId; a single FK can't span
    // two tables, so this is interpreted by code, not the schema.
    subjectId: uuid("subject_id").notNull(),
    kind: memoryKindEnum("kind").notNull(),
    // Constrained to a closed vocabulary in code (src/lib/memory/derived.ts's
    // DERIVED_MEMORY_KEYS, src/lib/memory/stated.ts's STATED_MEMORY_KEYS),
    // not a DB enum — derived and stated keys are different, disjoint
    // sets and a shared DB enum would blur that boundary.
    key: text("key").notNull(),
    // The constrained value a fixed per-key template renders. Never
    // concatenated raw into a prompt — see retrieve.ts. This is the
    // layer's central injection defence, alongside the closed key
    // vocabulary itself.
    value: text("value").notNull(),
    // Real provenance, required — a memory with no source cannot be
    // created. Derived: the table+row it was computed from. Stated: the
    // messages row it was extracted from.
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    // Null = pending/inert, never retrieved. Derived memories are
    // confirmed immediately (code-computed, nothing to review). A
    // stated memory stays null until a human confirms it — never
    // auto-confirmed.
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_memories_subject_key_idx").on(
      table.merchantId,
      table.subjectType,
      table.subjectId,
      table.key,
    ),
  ],
);

// Layer 19: the Theatre view's left-hand panel. The standalone
// agent-buyer/ package holds no database access at all (its own
// governing rule — see plans/layer-19-adversarial-buyer.md) and streams
// its local JSONL run log to a merchant-authenticated endpoint instead.
// rawLog is stored as an opaque, untrusted blob — never parsed into
// typed rows, never trusted as a source of truth about a money action
// (same discipline agentMemories.value documents above: constrained
// content the reader interprets through a fixed lens, not code that
// executes or joins against it). The Theatre view's right-hand panel
// comes from audit_log/money_actions, which the buyer agent cannot
// write — correlation is done by money action id found inside rawLog's
// own JSON lines, read at render time, never by a foreign key here.
export const buyerAgentRuns = pgTable("buyer_agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  // The buyer agent's own run id (a UUID it generates locally) — not
  // this row's own id, so re-ingesting the same run (a resumed upload)
  // can be recognised rather than duplicated.
  runId: text("run_id").notNull(),
  // The full JSONL log, verbatim. Bounded at the write boundary (see
  // the ingest route), never at the column type.
  rawLog: text("raw_log").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Layer 26-1: the distributed rate limiter's shared state. Replaces
// rate-limit.ts's in-memory Map — the identical "a table plus an atomic
// conditional UPDATE" primitive this codebase already used for
// spend_caps/product_variants/agent_tasks, rather than adding Redis.
// One row per (key, windowStart) — a request in a new window inserts a
// fresh row rather than mutating an old one, so the atomic increment
// below never has to decide whether the current window is stale.
export const rateLimitWindows = pgTable(
  "rate_limit_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Already includes the route, e.g. "chat:1.2.3.4" — checkRateLimit's
    // existing key shape, unchanged by this swap.
    limitKey: text("limit_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [uniqueIndex("rate_limit_windows_key_window_idx").on(table.limitKey, table.windowStart)],
);

// Layer 26-3: per-account login backoff state. Decaying, never a
// permanent lock — see password.ts/login/actions.ts and DECISIONS.md's
// "throttle over lockout" entry. Keyed by the attempted email, same
// identity the existing IP-based login rate limit already keys on.
export const loginThrottleState = pgTable("login_throttle_state", {
  email: text("email").primaryKey(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Layer 21: the protocol surface and proof of agency ---
// See plans/layer-21-protocol-surface.md. Merchant-authored policy for AI
// buyers as a CLASS (as opposed to agents.* / spend_caps, which are
// per-agent) — every field here is arithmetic or a boolean, enforced in
// gate.ts's checkBounds or agent-auth.ts like any other bound. Absence of
// a row means self-registration is closed and unknown agents need
// approval first — the conservative default, same "absence is real, not
// permissive" discipline merchant_policies already established.
export const merchantAgentTerms = pgTable("merchant_agent_terms", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  // Whether an agent with no prior history for this merchant may
  // transact at all without the merchant approving it first. Checked in
  // checkBounds — a false here denies a first-ever purchase from a brand
  // new agent regardless of what cap it's been given.
  unknownAgentsAllowed: boolean("unknown_agents_allowed").notNull().default(false),
  // A ceiling applied ON TOP OF an agent's own spend_caps.perTransactionMax
  // for an agent with zero prior completed purchases — the stricter of
  // the two applies. Null means no extra ceiling beyond the agent's own cap.
  newAgentOrderCeilingPaise: integer("new_agent_order_ceiling_paise"),
  // An order at or above this amount requires a verified AP2 Payment
  // Mandate regardless of the agent's own mandateRequired flag. Null
  // means no mandate-by-value escalation is configured.
  mandateRequiredAbovePaise: integer("mandate_required_above_paise"),
  // Whether negotiation:create may ever be granted to a self-registered
  // agent's default capability set (L21-8) — does not revoke the
  // capability from an agent a merchant granted it to by hand.
  negotiationOpenToAgents: boolean("negotiation_open_to_agents").notNull().default(false),
  // The capability set a self-registered agent starts with. Never
  // "purchase:create" alone implies unlimited spend — always paired with
  // selfRegisterStartingCapPaise below.
  selfRegisterDefaultCapabilities: agentCapabilityEnum("self_register_default_capabilities").array().notNull().default(sql`'{}'::agent_capability[]`),
  // Whether POST /api/agent/register is open at all. Default closed —
  // fail closed applied to onboarding, per the plan's explicit
  // instruction. A merchant with no row here (the common case until they
  // visit the terms page) gets false from this column's own default once
  // a row exists, and no self-registration path at all while no row
  // exists — see getMerchantAgentTerms's null-row handling.
  selfRegistrationOpen: boolean("self_registration_open").notNull().default(false),
  // The provisional spend cap a self-registered agent starts with — the
  // merchant's own number, never a hardcoded default this layer picks.
  selfRegisterStartingCapPaise: integer("self_register_starting_cap_paise"),
  selfRegisterPerTransactionMaxPaise: integer("self_register_per_transaction_max_paise"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 25: control surfaces ---
// See plans/layer-25-control-surfaces.md. "Everything here informs.
// Nothing here decides" — except the Kill Switch, which IS the merchant
// deciding, expressed through the Guardian bound gate.ts already
// enforces (resolveGuardianBound denies a suspended/revoked agent
// outright). Freezing is a bulk, audited application of that existing
// bound, never a new one.

// One row per merchant, present only while a freeze is active — absence
// means not frozen, the same "absence is real" discipline
// merchant_agent_terms/merchant_policies already use. Deleted (not
// soft-closed) on unfreeze, so "is this merchant frozen right now" is a
// single existence check every dashboard surface can share.
export const merchantFreezes = pgTable("merchant_freezes", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  reason: text("reason").notNull(),
  frozenAt: timestamp("frozen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Captures each active agent's Guardian state at the moment a freeze is
// thrown, so unfreeze can restore exactly what was there before rather
// than a blanket "back to normal" — an agent already suspended by the
// Guardian before the freeze must stay suspended after it. One row per
// (merchantId, agentId) per freeze; deleted once read back on unfreeze.
export const agentFreezeSnapshots = pgTable("agent_freeze_snapshots", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  priorState: guardianStateEnum("prior_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// An opt-in, revocable, unguessable token letting one specific decision
// be viewed outside the dashboard (L25-4) — a decision is not public
// data by default. Scoped to exactly one audit_log row; deleting the
// token (or never creating one) keeps the decision merchant-only.
export const decisionShareTokens = pgTable("decision_share_tokens", {
  token: text("token").primaryKey(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  auditLogId: uuid("audit_log_id")
    .notNull()
    .references(() => auditLog.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Layer 22: the returns desk ---
// See plans/layer-22-returns-desk.md. The governing rule: the model
// decides whether a request is worth the merchant's attention; code
// decides that only the merchant can approve it, and code computes
// every rupee. There is no function a model's output can reach that
// issues a refund — approve always routes through gate.ts's existing
// issueRefund, called only from the merchant's own dashboard action.

// Deliberately distinct terminal states rather than collapsing into
// escalations.outcome's shape: "declined_by_desk" is the model refusing
// to forward a request before a merchant ever saw it, and conflating
// that with "rejected" (a merchant's own decision) would misattribute
// a decision to a human who never made it — the same reasoning that
// keeps negotiations.status and the Agent Runtime's pending/waiting
// distinct (see DECISIONS.md).
export const returnRequestStatusEnum = pgEnum("return_request_status", [
  "awaiting_merchant",
  "declined_by_desk",
  "approved",
  "rejected",
  "expired",
  "refunded",
]);

export const returnRecommendationEnum = pgEnum("return_recommendation", [
  "approve",
  "reject",
  "needs_merchant_judgement",
]);

// A return request references a completed, CAPTURED purchase and may
// never produce a money action at all (most are declined by the desk or
// rejected) — unlike escalations, whose moneyActionId always points at
// a still-pending action. Forcing one table to serve both shapes would
// make the existing escalation-expiry sweep operate on rows it was
// never written for (see the plan's L22-1).
export const returnRequests = pgTable(
  "return_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    moneyActionId: uuid("money_action_id")
      .notNull()
      .references(() => moneyActions.id),
    // The requester's real, durable identity — never a session token.
    // Exactly one of these two is set, matching how memory subjects
    // (Layer 18) are anchored only to identities this product actually
    // has.
    requesterContactId: uuid("requester_contact_id").references(() => customerContacts.id),
    requesterAgentId: uuid("requester_agent_id").references(() => agents.id),
    // The buyer's stated reason, stored as the untrusted text it is —
    // never trusted as a fact, only ever shown as a quote.
    statedReason: text("stated_reason").notNull(),
    status: returnRequestStatusEnum("status").notNull().default("awaiting_merchant"),
    // Code-computed from the real money_actions row at L22-2 eligibility
    // time — the model never sees a chance to produce this number.
    refundableAmountPaise: integer("refundable_amount_paise").notNull(),
    // Set by the merchant on approval; defaults to refundableAmountPaise
    // but may be reduced for a partial refund. Still only ever a
    // merchant-entered or code-computed integer, never model output.
    approvedAmountPaise: integer("approved_amount_paise"),
    // Why the request ended where it did — either a deterministic
    // eligibility failure (L22-2), the desk's own decline reason, or
    // the merchant's typed decision reason. Always real prose, never
    // fabricated.
    resolutionReason: text("resolution_reason"),
    // The model's structured recommendation — stored as generated text,
    // clearly labelled as such everywhere it renders. This column and
    // the two below are drafting only; nothing reads them to decide
    // anything (see returns-desk.ts's structural isolation).
    modelSummary: text("model_summary"),
    modelRecommendation: returnRecommendationEnum("model_recommendation"),
    modelReasoning: text("model_reasoning"),
    // Set deterministically at creation from merchant_policies or a
    // default, mirroring escalations.expiresAt. Past this, the request
    // resolves as "expired" — never "approved". Silence is not consent.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A buyer cannot open five parallel requests for one purchase — but
    // once a request has resolved (declined/rejected/expired), a new
    // one may be opened, e.g. after clarifying a claim. Partial unique
    // index scoped to the one open status, same pattern
    // restock_requests_waiting_idx already uses.
    uniqueIndex("return_requests_open_idx")
      .on(table.moneyActionId)
      .where(sql`${table.status} = 'awaiting_merchant'`),
  ],
);

// One row per turn in the returns-desk conversation, kept separate from
// chatMessages since a return conversation is scoped to one request and
// one completed purchase, not a storefront session/cart.
export const returnRequestMessages = pgTable("return_request_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  returnRequestId: uuid("return_request_id")
    .notNull()
    .references(() => returnRequests.id),
  role: text("role").notNull(), // "buyer" | "assistant"
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

