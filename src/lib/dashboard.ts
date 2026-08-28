import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getRecentAuditEntries } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";

/**
 * Read queries for the merchant dashboard. Every function is scoped by
 * merchantId, resolved from the session by the caller — see
 * src/lib/auth.ts's getSessionMerchant/requireSessionMerchant.
 */

export interface AgentWithCap {
  id: string;
  name: string;
  status: (typeof schema.agentStatusEnum.enumValues)[number];
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

  return agents.map((agent) => {
    const cap = latestCapByAgentId.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
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
