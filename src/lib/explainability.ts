import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { MAX_BUYER_COUNTERS } from "@/lib/negotiation";

/**
 * Layer 7's unified refusal/deferral read layer. This module reads
 * decisions already recorded by the gate (audit_log), the risk layer
 * (escalations), the offer engine (offer_decisions), and the recovery
 * pipeline (audit_log again — recovery_stopped/recovery_escalated_to_human/
 * recovery_write_off events). It records nothing and decides nothing —
 * see plans/layer-7-explainability-refusal-log.md, "The one rule."
 */

export type DecisionSource = "gate" | "offer_engine" | "recovery" | "risk_escalation" | "negotiation";
export type DecisionKind = "refusal" | "deferral";
export type Determinism = "deterministic" | "model_influenced";

export interface DecisionArithmetic {
  label: string;
  value: string;
}

export interface UnifiedDecision {
  id: string;
  source: DecisionSource;
  kind: DecisionKind;
  determinism: Determinism;
  /** The recorded reason sentence, verbatim — never rewritten here. */
  reason: string;
  /** Human phrase for the bound/rule that fired, derived from a stable prefix. Raw string kept alongside for the details toggle. */
  boundLabel: string;
  boundRaw: string | null;
  /** Exact numbers that produced the decision, as structured data, never prose. */
  arithmetic: DecisionArithmetic[];
  agentId: string | null;
  agentName: string | null;
  sessionToken: string | null;
  createdAt: Date;
  /** Ids of the source row(s), for a drill-down that reads the real record. */
  sourceRef: { table: "audit_log" | "escalations" | "offer_decisions" | "negotiations"; id: string; moneyActionId?: string };
}

// A bound's stable prefix (the part before ":<id>", or the whole string
// for bounds with no id suffix) mapped to a phrase a merchant reads
// without decoding gate.ts. Unmapped prefixes render their raw form
// rather than a generic label — an unmapped bound must stay visible,
// never silently fall through to "Other" (plans/layer-7-...: "L7-1").
const BOUND_LABELS: Record<string, string> = {
  quantity_validity: "Invalid quantity requested",
  product_exists: "Product not found",
  product_status: "Product not active",
  product_price_match: "Buyer-asserted price didn't match the catalogue",
  product_stock: "Not enough stock",
  offer_price_match: "Buyer-asserted price didn't match the bundle",
  offer_bundle_stock: "Not enough stock for the bundle",
  purchase_target_ambiguous: "Request named more than one thing to buy",
  negotiation_exists: "Negotiation not found",
  negotiation_status: "Negotiation not agreed yet",
  negotiation_expiry: "Negotiated price expired",
  negotiation_identity: "Negotiation belongs to a different buyer",
  negotiation_price_match: "Buyer-asserted price didn't match the agreed negotiation",
  negotiation_stock: "Not enough stock for the negotiated purchase",
  amount_validity: "Invalid amount",
  merchant_razorpay_connected: "Merchant hasn't connected Razorpay",
  agent_exists: "Unknown agent",
  agent_status: "Agent not active",
  spend_cap_exists: "No spend cap set",
  spend_cap_status: "Spend cap not active",
  spend_cap_window: "Spend cap window has lapsed",
  per_transaction_max: "Over the per-transaction limit",
  spend_cap_balance: "Over the remaining spend cap balance",
  reward_coin_balance: "Not enough reward coin balance",
};

function boundPrefix(boundApplied: string): string {
  const idx = boundApplied.indexOf(":");
  return idx === -1 ? boundApplied : boundApplied.slice(0, idx);
}

function labelForBound(boundApplied: string | null): string {
  if (!boundApplied) return "No specific bound recorded";
  const prefix = boundPrefix(boundApplied);
  return BOUND_LABELS[prefix] ?? `Unmapped bound: ${boundApplied}`;
}

const RECOVERY_STOP_EVENTS = new Set([
  "recovery_stopped",
  "recovery_escalated_to_human",
  "recovery_write_off",
]);

// Exact stoppingRule values from recovery/policy.ts — verified against
// real recorded rows, not guessed (see plans/layer-7-...: "L7-2").
const RECOVERY_RULE_LABELS: Record<string, string> = {
  already_resolved: "Payment failure already resolved",
  unrecoverable_diagnosis: "Diagnosed as unrecoverable",
  max_attempts_reached: "Reached the maximum retry attempts",
  backoff_window_not_elapsed: "Too soon to retry — waiting out the backoff window",
  below_minimum_recoverable_amount: "Amount too small to be worth chasing",
  roi_governor: "Recovery would cost more than it's worth",
  high_value_requires_human: "High-value failure routed to a human",
};

/**
 * Parses "N attempt(s) at ₹X..." / "the ROI governor: ..." style reasons
 * into a small set of labelled numbers, matched on distinctive fixed
 * substrings from policy.ts's own reason text rather than free-form
 * parsing — if policy.ts's wording changes this degrades to an empty
 * arithmetic array, never a crash or a fabricated number.
 */
function extractRecoveryArithmetic(reason: string): DecisionArithmetic[] {
  const out: DecisionArithmetic[] = [];
  const attemptsMatch = reason.match(/after (\d+) attempts/);
  if (attemptsMatch) out.push({ label: "Attempts made", value: attemptsMatch[1] });
  const limitMatch = reason.match(/limit of (\d+) attempts/);
  if (limitMatch) out.push({ label: "Attempt limit", value: limitMatch[1] });
  const costMatch = reason.match(/would cost ₹([\d,.]+)/);
  if (costMatch) out.push({ label: "Recovery cost so far", value: `₹${costMatch[1]}` });
  const recoveredMatch = reason.match(/₹([\d,.]+) being recovered/);
  if (recoveredMatch) out.push({ label: "Amount being recovered", value: `₹${recoveredMatch[1]}` });
  const thresholdMatch = reason.match(/₹([\d,.]+) threshold/);
  if (thresholdMatch) out.push({ label: "High-value threshold", value: `₹${thresholdMatch[1]}` });
  return out;
}

// recovery_stopped carries a real stoppingRule as boundApplied
// (policy.ts's shouldAttemptRecovery declining to proceed at all).
// recovery_escalated_to_human / recovery_write_off are a DIFFERENT code
// path — chooseStrategy() mapping a decline category directly to a
// strategy that proceeds with recovery but deliberately moves no money
// — and carry no boundApplied, so they get a fixed per-event label
// instead of falling through to "unmapped" for every single row.
function recoveryRuleFromEvent(event: string, boundApplied: string | null): { label: string; raw: string | null } {
  if (boundApplied && RECOVERY_RULE_LABELS[boundApplied]) {
    return { label: RECOVERY_RULE_LABELS[boundApplied], raw: boundApplied };
  }
  if (event === "recovery_escalated_to_human") {
    return { label: "Recovery strategy: routed to a human, no automatic action", raw: null };
  }
  if (event === "recovery_write_off") {
    return { label: "Recovery strategy: written off, not worth attempting", raw: null };
  }
  return { label: boundApplied ? `Unmapped stopping rule: ${boundApplied}` : `Unmapped recovery event: ${event}`, raw: boundApplied };
}

interface FetchOptions {
  limit?: number;
  source?: DecisionSource;
  kind?: DecisionKind;
}

/**
 * Every deny/escalate audit_log row for the merchant, split into gate
 * refusals, recovery-pipeline refusals/deferrals, and risk escalations —
 * three different sources sharing one table. Escalations are read from
 * BOTH escalations (for the definitive outcome + risk_reason) and
 * audit_log (for the original decision event) so a resolved escalation's
 * full lifecycle is visible, not just its initial pending state —
 * getPendingEscalations() in dashboard.ts only returns outcome: "pending"
 * rows, which is deliberately narrower than what this surface needs.
 */
async function fetchGateAndRiskDecisions(merchantId: string, limit: number): Promise<UnifiedDecision[]> {
  const rows = await db
    .select({
      audit: schema.auditLog,
      agentName: schema.agents.name,
      moneyActionAgentId: schema.moneyActions.agentId,
    })
    .from(schema.auditLog)
    .leftJoin(schema.moneyActions, eq(schema.auditLog.moneyActionId, schema.moneyActions.id))
    .leftJoin(schema.agents, eq(schema.moneyActions.agentId, schema.agents.id))
    // deny or escalate — the real universe of gate/risk decisions. Also
    // named explicitly: recovery_write_off, which sequencer.ts writes
    // with decision: "n/a" (a strategy the pipeline chose, not a
    // deny — see recoveryRuleFromEvent's comment on the two different
    // recovery code paths) but which IS a genuine refusal on this
    // surface. Excluding "n/a" rows entirely (bundle_created,
    // merchant_policy_updated, payment_failure_diagnosed,
    // recovery_batch_completed, ...) matters: filtering on
    // "!= allow" alone left them in the fetched page and silently
    // under-filled the merge below once dropped downstream — verified
    // live against the real seeded merchant (see FAILURES.md).
    .where(
      and(
        eq(schema.auditLog.merchantId, merchantId),
        or(
          eq(schema.auditLog.decision, "deny"),
          eq(schema.auditLog.decision, "escalate"),
          eq(schema.auditLog.event, "recovery_write_off"),
        ),
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(limit);

  // Escalation outcomes (approved/rejected/pending), keyed by money
  // action id, so a "deny" decision from a rejected escalation and the
  // original "escalate" row can both be shown with the resolved state.
  const moneyActionIds = rows.map((r) => r.audit.moneyActionId).filter((id): id is string => id !== null);
  const escalationsByMoneyAction = new Map<string, (typeof schema.escalations.$inferSelect)>();
  if (moneyActionIds.length > 0) {
    const escalationRows = await db.select().from(schema.escalations).where(inArray(schema.escalations.moneyActionId, moneyActionIds));
    for (const e of escalationRows) escalationsByMoneyAction.set(e.moneyActionId, e);
  }

  const out: UnifiedDecision[] = [];

  for (const row of rows) {
    const { audit, agentName, moneyActionAgentId } = row;

    if (RECOVERY_STOP_EVENTS.has(audit.event)) {
      const rule = recoveryRuleFromEvent(audit.event, audit.boundApplied);
      out.push({
        id: audit.id,
        source: "recovery",
        // recovery_escalated_to_human hands off to a person and is a
        // deferral, matching risk_escalation's own kind — everything
        // else the recovery pipeline stops on (recovery_stopped's
        // policy-driven halts, recovery_write_off) is a genuine refusal:
        // no human is asked, no further action is taken.
        kind: audit.event === "recovery_escalated_to_human" ? "deferral" : "refusal",
        determinism: "deterministic",
        reason: audit.reason,
        boundLabel: rule.label,
        boundRaw: rule.raw,
        arithmetic: extractRecoveryArithmetic(audit.reason),
        agentId: moneyActionAgentId,
        agentName: agentName ?? null,
        sessionToken: null,
        createdAt: audit.createdAt,
        sourceRef: { table: "audit_log", id: audit.id, moneyActionId: audit.moneyActionId ?? undefined },
      });
      continue;
    }

    if (audit.decision === "escalate") {
      const escalation = audit.moneyActionId ? escalationsByMoneyAction.get(audit.moneyActionId) : undefined;
      out.push({
        id: audit.id,
        source: "risk_escalation",
        kind: "deferral",
        // A deterministic_fallback escalation involved no model judgment —
        // the risk layer's own source field says so (risk.ts). audit_log
        // doesn't carry that field directly, so it's read off the reason
        // text's own fixed prefix, written by risk.ts's deterministicFallback.
        determinism: audit.reason.startsWith("Model unavailable. Deterministic fallback:") ? "deterministic" : "model_influenced",
        reason: escalation?.riskReason ?? audit.reason,
        boundLabel: escalation ? `Escalated to merchant — ${escalation.outcome}` : "Escalated to merchant",
        boundRaw: audit.boundApplied,
        arithmetic: [],
        agentId: moneyActionAgentId,
        agentName: agentName ?? null,
        sessionToken: null,
        createdAt: audit.createdAt,
        sourceRef: {
          table: "escalations",
          id: escalation?.id ?? audit.id,
          moneyActionId: audit.moneyActionId ?? undefined,
        },
      });
      continue;
    }

    if (audit.decision === "deny") {
      out.push({
        id: audit.id,
        source: "gate",
        kind: "refusal",
        determinism: "deterministic",
        reason: audit.reason,
        boundLabel: labelForBound(audit.boundApplied),
        boundRaw: audit.boundApplied,
        arithmetic: [],
        agentId: moneyActionAgentId,
        agentName: agentName ?? null,
        sessionToken: null,
        createdAt: audit.createdAt,
        sourceRef: { table: "audit_log", id: audit.id, moneyActionId: audit.moneyActionId ?? undefined },
      });
    }
  }

  return out;
}

/**
 * Offer-engine non-offers only — an offer that WAS made (offeredOfferId
 * set) is not a refusal and is excluded here; it belongs to
 * getRecentOfferDecisions()'s existing surface (/dashboard/offers), not
 * this one. Deliberately never exposes per-candidate margin figures —
 * only the counts, which cost-paise-never-leaks.test.ts's extension
 * (L7-6) checks directly. See plans/layer-7-...: "Read this first" #2.
 */
async function fetchOfferRefusals(merchantId: string, limit: number): Promise<UnifiedDecision[]> {
  const rows = await db
    .select({
      decision: schema.offerDecisions,
      agentName: schema.agents.name,
    })
    .from(schema.offerDecisions)
    .leftJoin(schema.agents, eq(schema.offerDecisions.agentId, schema.agents.id))
    .where(and(eq(schema.offerDecisions.merchantId, merchantId), isNull(schema.offerDecisions.offeredOfferId)))
    .orderBy(desc(schema.offerDecisions.createdAt))
    .limit(limit);

  return rows.map(({ decision, agentName }) => {
    const reason = decision.noOfferReason ?? "No reason recorded.";
    // Model-influenced only when the model actually ran and declined or
    // was unavailable; an empty eligible set or an all-below-floor set
    // never reached the model at all (offer-engine.ts's own ordering —
    // see checkBounds' equivalent guarantee for the gate).
    const modelRan = reason.includes("Model unavailable") || reason.includes("Model declined");
    return {
      id: decision.id,
      source: "offer_engine" as const,
      kind: "refusal" as const,
      determinism: modelRan ? ("model_influenced" as const) : ("deterministic" as const),
      reason,
      boundLabel: decision.eligibleCandidateCount === 0 ? "No eligible bundle for this cart" : "No bundle cleared the margin floor",
      boundRaw: null,
      arithmetic: [
        { label: "Eligible candidates", value: String(decision.eligibleCandidateCount) },
        { label: "Below margin floor", value: String(decision.belowMarginFloorCount) },
      ],
      agentId: decision.agentId,
      agentName: agentName ?? null,
      sessionToken: decision.sessionToken,
      createdAt: decision.createdAt,
      sourceRef: { table: "offer_decisions" as const, id: decision.id },
    };
  });
}

/**
 * Negotiation refusals only (Layer 8) — an agreed/redeemed/open/expired
 * negotiation is not a refusal; only "refused_turns_exhausted" is (a
 * negotiation only ever fails by running out of counter-offer turns
 * while still below the floor — there is no separate "gave up early"
 * terminal state, see schema.ts's negotiationStatusEnum comment).
 * Deterministic: exhausting a turn budget is pure arithmetic in
 * negotiation.ts, never a model decision (see negotiation.ts's module
 * docstring, "the one rule"). Deliberately never exposes floorPricePaise
 * or costPaise — only the buyer's final offer and the turn count,
 * mirroring fetchOfferRefusals' margin-count-not-margin-value discipline.
 */
async function fetchNegotiationRefusals(merchantId: string, limit: number): Promise<UnifiedDecision[]> {
  const rows = await db
    .select({
      negotiation: schema.negotiations,
      agentName: schema.agents.name,
    })
    .from(schema.negotiations)
    .leftJoin(schema.agents, eq(schema.negotiations.agentId, schema.agents.id))
    .where(and(eq(schema.negotiations.merchantId, merchantId), eq(schema.negotiations.status, "refused_turns_exhausted")))
    .orderBy(desc(schema.negotiations.resolvedAt))
    .limit(limit);

  return rows.map(({ negotiation, agentName }) => {
    return {
      id: negotiation.id,
      source: "negotiation" as const,
      kind: "refusal" as const,
      // Exhausting a turn budget is pure arithmetic in negotiation.ts —
      // no model is ever asked whether to refuse.
      determinism: "deterministic" as const,
      reason: `Denied — after ${negotiation.buyerTurnCount} counter-offers, no agreement was reached within the turn limit.`,
      boundLabel: "Negotiation turn limit reached",
      boundRaw: "negotiation_turns_exhausted",
      arithmetic: [
        { label: "Buyer's final offer", value: negotiation.currentBuyerOfferPaise !== null ? `₹${(negotiation.currentBuyerOfferPaise / 100).toFixed(2)}` : "n/a" },
        { label: "Counter-offers made", value: String(negotiation.buyerTurnCount) },
        { label: "Turn limit", value: String(MAX_BUYER_COUNTERS) },
      ],
      agentId: negotiation.agentId,
      agentName: agentName ?? null,
      sessionToken: negotiation.sessionToken,
      createdAt: negotiation.resolvedAt ?? negotiation.createdAt,
      sourceRef: { table: "negotiations" as const, id: negotiation.id },
    };
  });
}

export interface DecisionStats {
  totalRefusals: number;
  totalDeferrals: number;
  bySource: Record<DecisionSource, number>;
  deterministicCount: number;
  modelInfluencedCount: number;
}

/**
 * Newest-first across all four sources, merchant-scoped. Each source is
 * fetched independently (bounded by `limit`) then merged and sorted in
 * code — a real UNION ALL across four differently-shaped tables with
 * different join paths would be a marginal win here and a real cost in
 * readability; see DECISIONS.md. Fetching `limit` per source before the
 * merge means the returned page is always complete for its window even
 * though it may be shorter than `limit` after merge+truncate.
 */
export async function getUnifiedDecisions(merchantId: string, options: FetchOptions = {}): Promise<UnifiedDecision[]> {
  const limit = options.limit ?? 50;

  const [gateAndRisk, offerRefusals, negotiationRefusals] = await Promise.all([
    fetchGateAndRiskDecisions(merchantId, limit),
    fetchOfferRefusals(merchantId, limit),
    fetchNegotiationRefusals(merchantId, limit),
  ]);

  let merged = [...gateAndRisk, ...offerRefusals, ...negotiationRefusals];
  if (options.source) merged = merged.filter((d) => d.source === options.source);
  if (options.kind) merged = merged.filter((d) => d.kind === options.kind);

  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return merged.slice(0, limit);
}

/**
 * Headline counts. Read at a wider window than the display list (a
 * dashboard row cap shouldn't silently cap the count merchants see) but
 * still merchant-scoped and still bounded — see "no claim of
 * completeness the audit log can't back" in the plan; these are counts
 * of what was recorded, not a guarantee nothing was ever dropped
 * (audit.ts's logAuditEntry never throws into a money path, so a DB
 * outage at write time is possible and would undercount here).
 */
export async function getDecisionStats(merchantId: string): Promise<DecisionStats> {
  const STATS_WINDOW = 2000;
  const all = await getUnifiedDecisions(merchantId, { limit: STATS_WINDOW });

  const bySource: Record<DecisionSource, number> = { gate: 0, offer_engine: 0, recovery: 0, risk_escalation: 0, negotiation: 0 };
  let totalRefusals = 0;
  let totalDeferrals = 0;
  let deterministicCount = 0;
  let modelInfluencedCount = 0;

  for (const d of all) {
    bySource[d.source]++;
    if (d.kind === "refusal") totalRefusals++;
    else totalDeferrals++;
    if (d.determinism === "deterministic") deterministicCount++;
    else modelInfluencedCount++;
  }

  return { totalRefusals, totalDeferrals, bySource, deterministicCount, modelInfluencedCount };
}

/**
 * One decision by its unified id, for a drill-down. Re-derives from the
 * real source row rather than trusting a cached/denormalised copy —
 * fetches the same sources getUnifiedDecisions does and finds the match,
 * since the id space (audit_log.id / offer_decisions.id) is shared
 * across sources by construction (both are UUID primary keys, and a
 * collision across two different tables' primary keys is not a
 * realistic concern at UUID's collision probability).
 */
export async function getDecisionById(merchantId: string, id: string): Promise<UnifiedDecision | null> {
  const [gateAndRisk, offerRefusals, negotiationRefusals] = await Promise.all([
    fetchGateAndRiskDecisions(merchantId, 2000),
    fetchOfferRefusals(merchantId, 2000),
    fetchNegotiationRefusals(merchantId, 2000),
  ]);
  return [...gateAndRisk, ...offerRefusals, ...negotiationRefusals].find((d) => d.id === id) ?? null;
}

/**
 * The decision (if any) recorded against a specific money action, scoped
 * additionally to the agent that owns it (L7-5's "why was I denied?" —
 * see plans/layer-7-...). Ownership is checked here, not left to the
 * caller: a money action belonging to a different agent never resolves,
 * even with a correct moneyActionId, matching agent/actions/[id]'s own
 * existing `and(eq(id), eq(agentId))` scoping.
 */
export async function getDecisionForMoneyAction(
  merchantId: string,
  moneyActionId: string,
  agentId: string,
): Promise<UnifiedDecision | null> {
  const [moneyAction] = await db
    .select({ id: schema.moneyActions.id })
    .from(schema.moneyActions)
    .where(
      and(
        eq(schema.moneyActions.id, moneyActionId),
        eq(schema.moneyActions.merchantId, merchantId),
        eq(schema.moneyActions.agentId, agentId),
      ),
    );
  if (!moneyAction) return null;

  const gateAndRisk = await fetchGateAndRiskDecisions(merchantId, 2000);
  return gateAndRisk.find((d) => d.sourceRef.moneyActionId === moneyActionId) ?? null;
}
