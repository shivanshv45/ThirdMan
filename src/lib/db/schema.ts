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

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  pricePaise: integer("price_paise").notNull(),
  // What margin-aware decisions in later layers (upsell, negotiation) read.
  // Unused by Layer 0/1 but included now to avoid retrofitting the schema.
  costPaise: integer("cost_paise").notNull(),
  // Written exclusively by the gate (Layer 4), via the same atomic
  // conditional-UPDATE pattern spend_caps.spentPaise already uses.
  stock: integer("stock").notNull(),
  // Archived products keep their history (past money_actions rows still
  // reference them) but don't appear in the catalogue or accept new
  // purchases. Never hard-delete a product — see setSpendCap's precedent
  // of revoke-don't-delete for agent keys (Layer 2-3).
  status: productStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    // product. When set, the price and stock bound were enforced against
    // this row, not the caller's say-so — see gate.ts.
    productId: uuid("product_id").references(() => products.id),
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
