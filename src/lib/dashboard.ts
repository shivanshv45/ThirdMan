import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getRecentAuditEntries } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { getSpansForMoneyAction } from "@/lib/tracing";
import { getUseCaseBudgetStatus } from "@/lib/model-router";
import { listTasksForMerchant, getTaskSteps } from "@/lib/runtime/tasks";

/**
 * Read queries for the merchant dashboard. Every function is scoped by
 * merchantId, resolved from the session by the caller — see
 * src/lib/auth.ts's getSessionMerchant/requireSessionMerchant.
 */

export interface AgentWithCap {
  id: string;
  name: string;
  status: (typeof schema.agentStatusEnum.enumValues)[number];
  mandateRequired: boolean;
  capabilities: (typeof schema.agentCapabilityEnum.enumValues)[number][];
  cap: {
    id: string;
    capPaise: number;
    spentPaise: number;
    remainingPaise: number;
    perTransactionMaxPaise: number;
    windowStart: Date;
    windowEnd: Date;
    status: (typeof schema.spendCapStatusEnum.enumValues)[number];
  } | null;
}

export async function getAgentsWithCaps(merchantId: string): Promise<AgentWithCap[]> {
  const agents = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.merchantId, merchantId))
    .orderBy(desc(schema.agents.createdAt));

  if (agents.length === 0) return [];

  // One query for every agent's spend caps rather than one query per
  // agent — the previous version issued a query per row in the loop.
  // The most recent cap per agent is picked in memory below, same
  // "latest wins" rule checkBounds uses in gate.ts.
  const allCaps = await db
    .select()
    .from(schema.spendCaps)
    .where(inArray(schema.spendCaps.agentId, agents.map((a) => a.id)))
    .orderBy(desc(schema.spendCaps.createdAt));

  const latestCapByAgentId = new Map<string, typeof schema.spendCaps.$inferSelect>();
  for (const cap of allCaps) {
    if (!latestCapByAgentId.has(cap.agentId)) {
      latestCapByAgentId.set(cap.agentId, cap);
    }
  }

  // Layer 13-2: every agent's granted capabilities, one query rather than
  // one per row — same batching discipline as allCaps above.
  const allCapabilities = await db
    .select()
    .from(schema.agentCapabilities)
    .where(inArray(schema.agentCapabilities.agentId, agents.map((a) => a.id)));

  const capabilitiesByAgentId = new Map<string, (typeof schema.agentCapabilityEnum.enumValues)[number][]>();
  for (const row of allCapabilities) {
    const list = capabilitiesByAgentId.get(row.agentId) ?? [];
    list.push(row.capability);
    capabilitiesByAgentId.set(row.agentId, list);
  }

  return agents.map((agent) => {
    const cap = latestCapByAgentId.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      mandateRequired: agent.mandateRequired,
      capabilities: capabilitiesByAgentId.get(agent.id) ?? [],
      cap: cap
        ? {
            id: cap.id,
            capPaise: cap.capPaise,
            spentPaise: cap.spentPaise,
            remainingPaise: Math.max(cap.capPaise - cap.spentPaise, 0),
            perTransactionMaxPaise: cap.perTransactionMaxPaise,
            windowStart: cap.windowStart,
            windowEnd: cap.windowEnd,
            status: cap.status,
          }
        : null,
    };
  });
}

export async function getAuditTrail(merchantId: string, limit = 100) {
  return getRecentAuditEntries(merchantId, limit);
}

/**
 * Layer 13-4: every agent belonging to this merchant currently
 * throttled or suspended, with the transition that put it there — the
 * incident list a merchant reads to decide whether to re-arm. Agents in
 * "normal" state are omitted; this is an incident view, not a status
 * board for every agent (that's /dashboard/agents).
 */
export async function getGuardianIncidents(merchantId: string) {
  const rows = await db
    .select({
      agentId: schema.agents.id,
      agentName: schema.agents.name,
      state: schema.agentGuardianState.state,
      lastSignal: schema.agentGuardianState.lastSignal,
      lastObservedValue: schema.agentGuardianState.lastObservedValue,
      lastBaselineValue: schema.agentGuardianState.lastBaselineValue,
      updatedAt: schema.agentGuardianState.updatedAt,
    })
    .from(schema.agentGuardianState)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentGuardianState.agentId))
    .where(and(eq(schema.agents.merchantId, merchantId), sql`${schema.agentGuardianState.state} != 'normal'`))
    .orderBy(desc(schema.agentGuardianState.updatedAt));

  return rows;
}

/** The full transition history for one agent — the transcript behind an incident, same "re-check ownership independently" discipline as getTranscript()/getDecisionForMoneyAction(). */
export async function getGuardianTransitions(merchantId: string, agentId: string) {
  const [agent] = await db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.merchantId, merchantId)));
  if (!agent) return [];

  return db
    .select()
    .from(schema.guardianTransitions)
    .where(eq(schema.guardianTransitions.agentId, agentId))
    .orderBy(desc(schema.guardianTransitions.createdAt))
    .limit(50);
}

/**
 * Whether a merchant has connected Razorpay, and a masked tail of the key
 * id for display. Never decrypts or returns the secret — the settings
 * page only ever needs to prove "something is connected," not the value.
 */
export async function getRazorpayConnectionStatus(
  merchantId: string,
): Promise<{ connected: boolean; maskedKeyId?: string }> {
  const [merchant] = await db
    .select({
      keyIdEncrypted: schema.merchants.razorpayKeyIdEncrypted,
      keySecretEncrypted: schema.merchants.razorpayKeySecretEncrypted,
    })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant?.keyIdEncrypted || !merchant?.keySecretEncrypted) {
    return { connected: false };
  }

  const keyId = decrypt(merchant.keyIdEncrypted);
  return { connected: true, maskedKeyId: `${keyId.slice(0, 8)}••••${keyId.slice(-4)}` };
}

export interface PendingEscalationRow {
  id: string;
  riskReason: string;
  createdAt: Date;
  moneyAction: {
    id: string;
    amountPaise: number;
    type: (typeof schema.moneyActionTypeEnum.enumValues)[number];
  };
  agent: { id: string; name: string } | null;
}

export interface ProductWithVariants {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  category: (typeof schema.productCategoryEnum.enumValues)[number];
  subcategory: string | null;
  status: (typeof schema.productStatusEnum.enumValues)[number];
  createdAt: Date;
  variants: (typeof schema.productVariants.$inferSelect)[];
}

/** A merchant's own catalogue, newest first, each product with its variants. Includes archived products/variants so the dashboard can show and reactivate them. */
export async function getProducts(merchantId: string): Promise<ProductWithVariants[]> {
  const [products, variants] = await Promise.all([
    db.select().from(schema.products).where(eq(schema.products.merchantId, merchantId)).orderBy(desc(schema.products.createdAt)),
    db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId)),
  ]);

  return products.map((p) => ({
    ...p,
    variants: variants.filter((v) => v.productId === p.id),
  }));
}

export interface EscrowHoldRow {
  id: string;
  outcome: (typeof schema.escrowHoldOutcomeEnum.enumValues)[number];
  expiresAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  moneyAction: {
    id: string;
    amountPaise: number;
    status: (typeof schema.moneyActionStatusEnum.enumValues)[number];
    productId: string | null;
  };
  productName: string | null;
}

/** Every escrow hold for a merchant, newest first — including resolved ones, so the dashboard can show history, not just what's currently held. */
export async function getEscrowHolds(merchantId: string): Promise<EscrowHoldRow[]> {
  const rows = await db
    .select({
      hold: schema.escrowHolds,
      moneyAction: schema.moneyActions,
      productName: schema.products.name,
    })
    .from(schema.escrowHolds)
    .innerJoin(schema.moneyActions, eq(schema.escrowHolds.moneyActionId, schema.moneyActions.id))
    .leftJoin(schema.products, eq(schema.moneyActions.productId, schema.products.id))
    .where(eq(schema.escrowHolds.merchantId, merchantId))
    .orderBy(desc(schema.escrowHolds.createdAt));

  return rows.map((r) => ({
    id: r.hold.id,
    outcome: r.hold.outcome,
    expiresAt: r.hold.expiresAt,
    resolvedAt: r.hold.resolvedAt,
    createdAt: r.hold.createdAt,
    moneyAction: {
      id: r.moneyAction.id,
      amountPaise: r.moneyAction.amountPaise,
      status: r.moneyAction.status,
      productId: r.moneyAction.productId,
    },
    productName: r.productName,
  }));
}

/** A merchant's structured return/refund/shipping terms (Layer 5-3), or null if never published — a genuinely unset state, not a default. */
export async function getMerchantPolicy(merchantId: string) {
  const [policy] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId));
  return policy ?? null;
}

export async function getRewardSettingsForDashboard(merchantId: string) {
  const [settings] = await db.select().from(schema.merchantRewardSettings).where(eq(schema.merchantRewardSettings.merchantId, merchantId));
  return settings ?? null;
}

/** Layer 11-8: every tier, enabled or not — the dashboard is the one surface that needs to see a disabled tier to re-enable it. ai-credits.ts's getEnabledTiers is the buyer-facing read (enabled only). */
export async function getAiCreditTiersForDashboard(merchantId: string) {
  return db.select().from(schema.aiCreditTiers).where(eq(schema.aiCreditTiers.merchantId, merchantId));
}

export interface RewardLedgerStats {
  totalIssuedCoins: number;
  totalRedeemedCoins: number;
  netOutstandingCoins: number;
  ledgerEntryCount: number;
}

/** Headline reward-program numbers — every coin issued/redeemed, summed straight from the ledger, never a cached total (same discipline as getOfferDecisionStats). */
export async function getRewardLedgerStats(merchantId: string): Promise<RewardLedgerStats> {
  const rows = await db.select().from(schema.rewardCoinLedger).where(eq(schema.rewardCoinLedger.merchantId, merchantId));

  let totalIssuedCoins = 0;
  let totalRedeemedCoins = 0;
  for (const row of rows) {
    if (row.coinsDelta > 0) totalIssuedCoins += row.coinsDelta;
    else totalRedeemedCoins += -row.coinsDelta;
  }

  return {
    totalIssuedCoins,
    totalRedeemedCoins,
    netOutstandingCoins: totalIssuedCoins - totalRedeemedCoins,
    ledgerEntryCount: rows.length,
  };
}

export interface OfferDecisionStats {
  totalRuns: number;
  offered: number;
  accepted: number;
  declined: number;
  expired: number;
  /** Runs where the engine deliberately made no offer — the refusal count, a headline number not a footnote (Layer 6-4). */
  noOffer: number;
}

/** The offer/refusal log's headline numbers — every engine run, whether or not it produced an offer. See ARCHITECTURE.md, "The offer engine." */
export async function getOfferDecisionStats(merchantId: string): Promise<OfferDecisionStats> {
  const decisions = await db.select().from(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));

  const offerIds = decisions.map((d) => d.offeredOfferId).filter((id): id is string => id !== null);
  const offers = offerIds.length > 0 ? await db.select().from(schema.offers).where(inArray(schema.offers.id, offerIds)) : [];
  const statusById = new Map(offers.map((o) => [o.id, o.status]));

  let offered = 0;
  let accepted = 0;
  let declined = 0;
  let expired = 0;
  let noOffer = 0;

  for (const d of decisions) {
    if (!d.offeredOfferId) {
      noOffer++;
      continue;
    }
    const status = statusById.get(d.offeredOfferId);
    offered++;
    if (status === "accepted") accepted++;
    else if (status === "declined") declined++;
    else if (status === "expired") expired++;
  }

  return { totalRuns: decisions.length, offered, accepted, declined, expired, noOffer };
}

export interface OfferDecisionRow {
  id: string;
  createdAt: Date;
  eligibleCandidateCount: number;
  belowMarginFloorCount: number;
  offer: { id: string; bundleName: string; amountPaise: number; reasonText: string; status: string } | null;
  noOfferReason: string | null;
}

/** Recent offer/refusal decisions, newest first — every run's exact arithmetic, so a refusal is auditable the same way a gate denial is. */
export async function getRecentOfferDecisions(merchantId: string, limit = 50): Promise<OfferDecisionRow[]> {
  const decisions = await db
    .select()
    .from(schema.offerDecisions)
    .where(eq(schema.offerDecisions.merchantId, merchantId))
    .orderBy(desc(schema.offerDecisions.createdAt))
    .limit(limit);

  const offerIds = decisions.map((d) => d.offeredOfferId).filter((id): id is string => id !== null);
  const offers = offerIds.length > 0 ? await db.select().from(schema.offers).where(inArray(schema.offers.id, offerIds)) : [];
  const offerById = new Map(offers.map((o) => [o.id, o]));

  const bundleIds = [...new Set(offers.map((o) => o.bundleId))];
  const bundles = bundleIds.length > 0 ? await db.select().from(schema.bundles).where(inArray(schema.bundles.id, bundleIds)) : [];
  const bundleById = new Map(bundles.map((b) => [b.id, b]));

  return decisions.map((d) => {
    const offer = d.offeredOfferId ? offerById.get(d.offeredOfferId) : undefined;
    const bundle = offer ? bundleById.get(offer.bundleId) : undefined;
    return {
      id: d.id,
      createdAt: d.createdAt,
      eligibleCandidateCount: d.eligibleCandidateCount,
      belowMarginFloorCount: d.belowMarginFloorCount,
      offer: offer && bundle ? { id: offer.id, bundleName: bundle.name, amountPaise: bundle.bundlePricePaise, reasonText: offer.reasonText, status: offer.status } : null,
      noOfferReason: d.noOfferReason,
    };
  });
}

export async function getPendingEscalations(merchantId: string): Promise<PendingEscalationRow[]> {
  const rows = await db
    .select({
      escalation: schema.escalations,
      moneyAction: schema.moneyActions,
      agent: schema.agents,
    })
    .from(schema.escalations)
    .innerJoin(schema.moneyActions, eq(schema.escalations.moneyActionId, schema.moneyActions.id))
    .leftJoin(schema.agents, eq(schema.moneyActions.agentId, schema.agents.id))
    .where(and(eq(schema.escalations.outcome, "pending"), eq(schema.moneyActions.merchantId, merchantId)))
    .orderBy(desc(schema.escalations.createdAt));

  return rows.map((r) => ({
    id: r.escalation.id,
    riskReason: r.escalation.riskReason,
    createdAt: r.escalation.createdAt,
    moneyAction: {
      id: r.moneyAction.id,
      amountPaise: r.moneyAction.amountPaise,
      type: r.moneyAction.type,
    },
    agent: r.agent ? { id: r.agent.id, name: r.agent.name } : null,
  }));
}

export interface NegotiationRow {
  id: string;
  status: (typeof schema.negotiationStatusEnum.enumValues)[number];
  variantSku: string;
  quantity: number;
  catalogueUnitPricePaise: number;
  floorUnitPricePaise: number;
  agreedUnitPricePaise: number | null;
  buyerTurnCount: number;
  agentName: string | null;
  sessionToken: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** Every negotiation for this merchant, newest first — the dashboard's negotiation log (Layer 8). */
export async function getRecentNegotiations(merchantId: string, limit = 50): Promise<NegotiationRow[]> {
  const rows = await db
    .select({
      negotiation: schema.negotiations,
      variantSku: schema.productVariants.sku,
      agentName: schema.agents.name,
    })
    .from(schema.negotiations)
    .innerJoin(schema.productVariants, eq(schema.negotiations.variantId, schema.productVariants.id))
    .leftJoin(schema.agents, eq(schema.negotiations.agentId, schema.agents.id))
    .where(eq(schema.negotiations.merchantId, merchantId))
    .orderBy(desc(schema.negotiations.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.negotiation.id,
    status: r.negotiation.status,
    variantSku: r.variantSku,
    quantity: r.negotiation.quantity,
    catalogueUnitPricePaise: r.negotiation.catalogueUnitPricePaise,
    floorUnitPricePaise: r.negotiation.floorUnitPricePaise,
    agreedUnitPricePaise: r.negotiation.agreedUnitPricePaise,
    buyerTurnCount: r.negotiation.buyerTurnCount,
    agentName: r.agentName ?? null,
    sessionToken: r.negotiation.sessionToken,
    createdAt: r.negotiation.createdAt,
    resolvedAt: r.negotiation.resolvedAt,
  }));
}

export interface NegotiableVariantRow {
  variantId: string;
  productName: string;
  sku: string;
  pricePaise: number;
  costPaise: number;
  floorPricePaise: number | null;
  belowCostFloorAcknowledged: boolean;
}

/** Every active variant with its current negotiation floor (or lack of one) — the dashboard's floor-setting form (Layer 8). */
export async function getNegotiableVariants(merchantId: string): Promise<NegotiableVariantRow[]> {
  const rows = await db
    .select({
      variantId: schema.productVariants.id,
      productName: schema.products.name,
      sku: schema.productVariants.sku,
      pricePaise: schema.productVariants.pricePaise,
      costPaise: schema.productVariants.costPaise,
      floorPricePaise: schema.productVariants.floorPricePaise,
      belowCostFloorAcknowledged: schema.productVariants.belowCostFloorAcknowledged,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .where(and(eq(schema.productVariants.merchantId, merchantId), eq(schema.productVariants.status, "active")));

  return rows;
}

export interface MoneyMovedStats {
  capturedPaise: number;
  capturedCount: number;
}

/**
 * The command view's "money moved" headline (Layer 9) — real captured
 * revenue only, never an order merely created. Sums money_actions
 * directly rather than reusing recovery's recoveredPaise (a different,
 * narrower number: only what the recovery pipeline itself recovered),
 * so the two headline figures stay honestly distinct.
 */
export async function getMoneyMovedStats(merchantId: string): Promise<MoneyMovedStats> {
  const [row] = await db
    .select({
      capturedPaise: sql<string>`coalesce(sum(${schema.moneyActions.amountPaise}), 0)`,
      capturedCount: sql<number>`count(*)`,
    })
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.merchantId, merchantId), eq(schema.moneyActions.status, "captured")));

  return {
    capturedPaise: Number(row?.capturedPaise ?? 0),
    capturedCount: Number(row?.capturedCount ?? 0),
  };
}

export interface DecisionCounts {
  allow: number;
  deny: number;
  escalate: number;
}

/**
 * Raw allow/deny/escalate counts straight off audit_log, merchant-
 * scoped — the command view's composition snapshot (Layer 9). Deliberately
 * simpler than explainability.ts's refusal/deferral classification: this
 * is every logged decision of each kind, not a curated refusal set.
 */
export async function getDecisionCounts(merchantId: string): Promise<DecisionCounts> {
  const rows = await db
    .select({ decision: schema.auditLog.decision, n: sql<number>`count(*)` })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.merchantId, merchantId))
    .groupBy(schema.auditLog.decision);

  const counts: DecisionCounts = { allow: 0, deny: 0, escalate: 0 };
  for (const row of rows) {
    if (row.decision === "allow" || row.decision === "deny" || row.decision === "escalate") {
      counts[row.decision] = Number(row.n);
    }
  }
  return counts;
}

// --- Layer 14: the AI Treasury dashboard ---

export interface TreasuryLedgerEntry {
  id: string;
  bucket: (typeof schema.treasuryLedgerBucketEnum.enumValues)[number];
  amountPaise: number;
  reason: (typeof schema.treasuryLedgerReasonEnum.enumValues)[number];
  createdAt: Date;
}

/** Most recent treasury ledger rows, newest first — every figure on the dashboard traces back to a row from this table (CLAUDE.md's no-fabricated-data rule). */
export async function getRecentTreasuryLedgerEntries(merchantId: string, limit = 30): Promise<TreasuryLedgerEntry[]> {
  return db
    .select({
      id: schema.treasuryLedger.id,
      bucket: schema.treasuryLedger.bucket,
      amountPaise: schema.treasuryLedger.amountPaise,
      reason: schema.treasuryLedger.reason,
      createdAt: schema.treasuryLedger.createdAt,
    })
    .from(schema.treasuryLedger)
    .where(eq(schema.treasuryLedger.merchantId, merchantId))
    .orderBy(desc(schema.treasuryLedger.createdAt))
    .limit(limit);
}

export interface WaterfallStep {
  label: string;
  durationMs: number;
  detail: string;
  ok: boolean;
}

/**
 * Layer 15-2: a fixed, human-labelled display order for the money-path
 * spans tracing.ts captures (see gate.ts/llm.ts/audit.ts's withSpan
 * call sites) — a span name not in this map still renders, under its
 * raw name, rather than being silently dropped, so an uninstrumented or
 * future step is still visible instead of invisible.
 */
const WATERFALL_STEP_LABELS: Record<string, string> = {
  mandate_verification: "Mandate verification",
  capability_check: "Capability check",
  guardian_state: "Guardian state",
  policy_evaluation: "Policy evaluation",
  risk_assessment: "Risk assessment",
  chat: "Model call",
  execute_and_settle: "Execute and settle",
  razorpay_authorize: "Razorpay authorize",
  ledger_commit: "Ledger commit",
  audit_write: "Audit write",
};

function describeWaterfallStep(name: string, attributes: Record<string, unknown>): string {
  switch (name) {
    case "mandate_verification":
      return "ES256, checkout hash checked";
    case "capability_check":
      return typeof attributes["thirdman.capability"] === "string" ? `${attributes["thirdman.capability"]} required` : "";
    case "guardian_state":
      return "evaluated against the agent's own rolling baseline";
    case "policy_evaluation": {
      const amountPaise = attributes["thirdman.amount_paise"];
      return typeof amountPaise === "number" ? `spend cap, stock, price match for ₹${(amountPaise / 100).toFixed(2)}` : "spend cap, stock, price match";
    }
    case "risk_assessment":
      return "deterministic fallback or a real model call";
    case "chat": {
      const model = attributes["gen_ai.response.model"] ?? attributes["gen_ai.request.model"];
      const inTok = attributes["gen_ai.usage.input_tokens"];
      const outTok = attributes["gen_ai.usage.output_tokens"];
      const parts = [attributes["gen_ai.system"], model].filter(Boolean).join("/");
      const tokens = typeof inTok === "number" && typeof outTok === "number" ? `${inTok + outTok} tokens` : undefined;
      return [parts, tokens].filter(Boolean).join(" · ");
    }
    case "razorpay_authorize":
      return "real Razorpay order/link created";
    case "ledger_commit":
      return "money_actions row updated";
    case "audit_write":
      return typeof attributes["thirdman.event"] === "string" ? String(attributes["thirdman.event"]) : "";
    default:
      return "";
  }
}

export interface MoneyAtRiskSummary {
  failedPaymentsAwaitingRecovery: { count: number; amountPaise: number };
  abandonedCarts: { count: number };
  outOfStockWithDemand: { count: number };
  pendingEscalations: { count: number; amountPaise: number };
  suspendedAgents: { count: number };
  aiSpendAgainstBudget: { configuredUseCases: number; overBudgetUseCases: number };
}

/**
 * Layer 15-4: the command view's "where am I losing money right now"
 * summary — six real aggregations, each over a table this app already
 * owns and already queries elsewhere. Every function reused here
 * (getPendingEscalations, getGuardianIncidents) is the identical
 * merchant-scoped query the rest of the dashboard already trusts;
 * nothing here re-derives a number a different path could disagree
 * with. Deliberately excludes ad spend, support tickets, subscriptions,
 * and settlement mismatch — this app holds no real table for any of
 * them, and CLAUDE.md's no-fabricated-data rule means a smaller honest
 * view beats a larger invented one. See plans/layer-15.
 */
export async function getMoneyAtRiskSummary(merchantId: string): Promise<MoneyAtRiskSummary> {
  const [failedPayments, abandonedCartRows, outOfStockRows, pendingEscalations, guardianIncidents, useCaseStatuses] = await Promise.all([
    db
      .select({ amountPaise: schema.paymentFailures.amountPaise })
      .from(schema.paymentFailures)
      .where(and(eq(schema.paymentFailures.merchantId, merchantId), inArray(schema.paymentFailures.status, ["new", "diagnosed", "recovering"]))),

    // A cart is "abandoned" once it has at least one line and no
    // corresponding cart_purchases row yet — distinct conversations only.
    db
      .selectDistinct({ conversationId: schema.cartItems.conversationId })
      .from(schema.cartItems)
      .innerJoin(schema.conversations, eq(schema.cartItems.conversationId, schema.conversations.id))
      .leftJoin(schema.cartPurchases, eq(schema.cartPurchases.conversationId, schema.cartItems.conversationId))
      .where(and(eq(schema.conversations.merchantId, merchantId), sql`${schema.cartPurchases.id} is null`)),

    db
      .select({ id: schema.restockRequests.id })
      .from(schema.restockRequests)
      .where(and(eq(schema.restockRequests.merchantId, merchantId), eq(schema.restockRequests.status, "waiting"))),

    getPendingEscalations(merchantId),
    getGuardianIncidents(merchantId),

    Promise.all(
      (["support_chat", "recovery_diagnosis", "negotiation", "classification"] as const).map((useCase) => getUseCaseBudgetStatus(merchantId, useCase)),
    ),
  ]);

  return {
    failedPaymentsAwaitingRecovery: {
      count: failedPayments.length,
      amountPaise: failedPayments.reduce((sum, f) => sum + f.amountPaise, 0),
    },
    abandonedCarts: { count: abandonedCartRows.length },
    outOfStockWithDemand: { count: outOfStockRows.length },
    pendingEscalations: {
      count: pendingEscalations.length,
      amountPaise: pendingEscalations.reduce((sum, e) => sum + e.moneyAction.amountPaise, 0),
    },
    suspendedAgents: { count: guardianIncidents.filter((g) => g.state === "suspended").length },
    aiSpendAgainstBudget: {
      configuredUseCases: useCaseStatuses.filter((s) => s.configured).length,
      overBudgetUseCases: useCaseStatuses.filter((s) => s.configured && s.remainingPaise <= 0).length,
    },
  };
}

/**
 * The per-decision timing waterfall (Layer 15-2): verifies the money
 * action belongs to this merchant (same ownership discipline as
 * getGuardianTransitions/getDecisionForMoneyAction — never trust an id
 * without re-checking it), then reads back whatever spans tracing.ts
 * captured for it. Empty if none were captured — a decision that
 * predates this layer, or whose spans have since been evicted from the
 * in-memory ring buffer — which the caller renders as an honest empty
 * state, never a fabricated timing row (CLAUDE.md's no-fabricated-data rule).
 */
export async function getDecisionWaterfall(merchantId: string, moneyActionId: string): Promise<WaterfallStep[]> {
  const [moneyAction] = await db
    .select({ id: schema.moneyActions.id })
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.id, moneyActionId), eq(schema.moneyActions.merchantId, merchantId)));
  if (!moneyAction) return [];

  const spans = getSpansForMoneyAction(moneyActionId);

  return spans.map((span) => ({
    label: WATERFALL_STEP_LABELS[span.name] ?? span.name,
    durationMs: Math.round(span.durationMs * 100) / 100,
    detail: describeWaterfallStep(span.name, span.attributes as Record<string, unknown>),
    ok: span.ok,
  }));
}

/** Layer 17: the merchant-facing task view's data — every real agent_tasks row, newest first, with its real step history. */
export async function getTasksForMerchant(merchantId: string) {
  const tasks = await listTasksForMerchant(merchantId);
  const withSteps = await Promise.all(
    tasks.map(async (task) => ({
      ...task,
      steps: await getTaskSteps(task.id),
    })),
  );
  return withSteps.reverse(); // listTasksForMerchant orders oldest-first; the dashboard reads newest-first, matching every other activity list in this codebase
}

/** How many tasks are currently active (not yet terminal) — the sidebar badge, same pattern as getGuardianIncidents/getPendingEscalations. */
export async function getActiveTaskCount(merchantId: string): Promise<number> {
  const tasks = await listTasksForMerchant(merchantId);
  return tasks.filter((t) => t.status === "pending" || t.status === "waiting" || t.status === "claimed").length;
}

// --- Layer 18: the Memory Bank dashboard read ---

export interface MemoryRow {
  id: string;
  subjectType: (typeof schema.memorySubjectTypeEnum.enumValues)[number];
  subjectId: string;
  subjectLabel: string;
  kind: (typeof schema.memoryKindEnum.enumValues)[number];
  key: string;
  value: string;
  sourceType: string;
  sourceId: string;
  confirmedAt: Date | null;
  expiresAt: Date | null;
  updatedAt: Date;
}

/**
 * Every real memory row for this merchant, newest first, with a
 * resolved human-readable subject label — an agent's real name, or a
 * customer contact's real address. No fabricated rows: an empty result
 * is rendered as EmptyState by the page, never padded.
 */
export async function getMemoryOverview(merchantId: string): Promise<MemoryRow[]> {
  const rows = await db.select().from(schema.agentMemories).where(eq(schema.agentMemories.merchantId, merchantId)).orderBy(desc(schema.agentMemories.updatedAt));

  const agentIds = rows.filter((r) => r.subjectType === "agent").map((r) => r.subjectId);
  const contactIds = rows.filter((r) => r.subjectType === "customer_contact").map((r) => r.subjectId);

  const [agentRows, contactRows] = await Promise.all([
    agentIds.length ? db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agentIds)) : Promise.resolve([]),
    contactIds.length
      ? db.select({ id: schema.customerContacts.id, address: schema.customerContacts.address }).from(schema.customerContacts).where(inArray(schema.customerContacts.id, contactIds))
      : Promise.resolve([]),
  ]);

  const agentNameById = new Map(agentRows.map((a) => [a.id, a.name]));
  const contactAddressById = new Map(contactRows.map((c) => [c.id, c.address]));

  return rows.map((row) => ({
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectLabel:
      row.subjectType === "agent"
        ? (agentNameById.get(row.subjectId) ?? "Unknown agent")
        : (contactAddressById.get(row.subjectId) ?? "Unknown contact"),
    kind: row.kind,
    key: row.key,
    value: row.value,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    confirmedAt: row.confirmedAt,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  }));
}

/** Stated memories awaiting merchant confirmation — the sidebar badge, same pattern as getGuardianIncidents/getActiveTaskCount. */
export async function getPendingMemoryConfirmCount(merchantId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.agentMemories.id })
    .from(schema.agentMemories)
    .where(and(eq(schema.agentMemories.merchantId, merchantId), eq(schema.agentMemories.kind, "stated"), sql`${schema.agentMemories.confirmedAt} is null`));
  return rows.length;
}

