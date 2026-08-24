import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
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
  stock: integer("stock").notNull(),
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
    type: moneyActionTypeEnum("type").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: moneyActionStatusEnum("status").notNull(),
    // The corresponding Razorpay order/payment/refund id, once one exists.
    razorpayEntityId: text("razorpay_entity_id"),
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
