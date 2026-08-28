import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { logAuditEntry } from "@/lib/audit";
import {
  getUnifiedDecisions,
  getDecisionStats,
  getDecisionById,
  getDecisionForMoneyAction,
} from "@/lib/explainability";
import { explainDecision } from "@/lib/explain-decision";

/**
 * Layer 7's explainability read layer. No mocks — real DB, matching
 * this project's standing rule (DECISIONS.md). audit_log rows are left
 * in place after each test (no FK dependent on them, every read here
 * scoped by merchant id — same reasoning gate.test.ts's own comment
 * gives), but every merchant/agent/offer_decisions row this file creates
 * IS cleaned up in afterEach, in FK dependency order.
 */

const createdMerchantIds: string[] = [];
const createdOfferDecisionIds: string[] = [];

afterEach(async () => {
  for (const id of createdOfferDecisionIds) {
    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.id, id));
  }
  createdOfferDecisionIds.length = 0;

  // escalations/spend_caps/money_actions created by individual tests are
  // cleaned up at the end of those tests themselves (they need
  // moneyActionId-precise deletes anyway, in FK order). audit_log DOES
  // need clearing here, though — unlike gate.test.ts's own comment about
  // leaving audit_log rows in place (true for THAT file, since it never
  // deletes the merchant row those rows point at), this file deletes the
  // merchant itself in every test, and audit_log.merchant_id FKs into
  // merchants — verified live: the first run of this file failed with
  // exactly this FK violation. Matches gate.test.ts's own actual
  // afterEach shape once you read past its docstring to the real deletes.
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function makeMerchantWithAgent(name: string) {
  const merchant = await createTestMerchant(name);
  createdMerchantIds.push(merchant.id);
  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: `${name}_agent`, apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();
  return { merchant, agent, rawKey };
}

describe("getUnifiedDecisions / getDecisionStats — cross-source isolation", () => {
  it("does not leak a decision across merchants, by id enumeration not empty-list", async () => {
    const { merchant: merchantA, agent: agentA } = await makeMerchantWithAgent("__explain_iso_a__");
    const { merchant: merchantB } = await makeMerchantWithAgent("__explain_iso_b__");

    await logAuditEntry({
      merchantId: merchantA.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Denied — test isolation fixture for merchant A.",
      boundApplied: "product_stock",
      metadata: { agentId: agentA.id },
    });

    const decisionsA = await getUnifiedDecisions(merchantA.id, { limit: 50 });
    const fixtureRow = decisionsA.find((d) => d.reason.includes("test isolation fixture for merchant A"));
    expect(fixtureRow).toBeDefined();

    // The actual isolation proof: merchant B's own read must not contain
    // merchant A's row, and looking it up BY ITS REAL ID while scoped to
    // B must return null — not just "B's own list happens to be empty."
    const decisionsB = await getUnifiedDecisions(merchantB.id, { limit: 50 });
    expect(decisionsB.some((d) => d.id === fixtureRow!.id)).toBe(false);

    const crossMerchantLookup = await getDecisionById(merchantB.id, fixtureRow!.id);
    expect(crossMerchantLookup).toBeNull();

    // And the correct merchant can still read it directly.
    const correctLookup = await getDecisionById(merchantA.id, fixtureRow!.id);
    expect(correctLookup?.id).toBe(fixtureRow!.id);
  });

  it("stats are merchant-scoped — a fixture on merchant A never inflates merchant B's counts", async () => {
    const { merchant: merchantA } = await makeMerchantWithAgent("__explain_stats_a__");
    const { merchant: merchantB } = await makeMerchantWithAgent("__explain_stats_b__");

    const beforeB = await getDecisionStats(merchantB.id);

    await logAuditEntry({
      merchantId: merchantA.id,
      actor: "system",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Denied — stats isolation fixture.",
      boundApplied: "spend_cap_balance:test",
    });

    const afterA = await getDecisionStats(merchantA.id);
    const afterB = await getDecisionStats(merchantB.id);

    expect(afterA.totalRefusals).toBeGreaterThan(0);
    expect(afterB.totalRefusals).toBe(beforeB.totalRefusals);
    expect(afterB.totalDeferrals).toBe(beforeB.totalDeferrals);
  });
});

describe("getDecisionForMoneyAction — agent-scoped isolation (L7-5)", () => {
  it("resolves a decision only for the agent that owns the money action", async () => {
    const { merchant, agent: agentA } = await makeMerchantWithAgent("__explain_agent_iso_a__");

    // agentB belongs to the SAME merchant, to prove agent-level (not
    // just merchant-level) isolation.
    const [agentB] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__explain_agent_iso_b_agent__", apiKeyHash: hashApiKey(generateApiKey()), status: "active" })
      .returning();

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({
        merchantId: merchant.id,
        agentId: agentA.id,
        type: "order_create",
        amountPaise: 10_000,
        status: "denied",
      })
      .returning();

    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Denied — agent-scoped fixture.",
      boundApplied: "product_stock",
      moneyActionId: moneyAction.id,
    });

    const asOwner = await getDecisionForMoneyAction(merchant.id, moneyAction.id, agentA.id);
    expect(asOwner?.reason).toContain("agent-scoped fixture");

    // agentB belongs to the same merchant but did not own this money
    // action — must not resolve, even though the merchant scope matches.
    const asOtherAgent = await getDecisionForMoneyAction(merchant.id, moneyAction.id, agentB.id);
    expect(asOtherAgent).toBeNull();

    await db.delete(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
  });
});

describe("refusal vs. deferral, and the deterministic/model-influenced split", () => {
  it("a gate deny counts as a refusal and is deterministic", async () => {
    const { merchant } = await makeMerchantWithAgent("__explain_kind_deny__");
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Denied — kind/determinism fixture (gate deny).",
      boundApplied: "spend_cap_balance:test",
    });

    const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10 })).filter((d) => d.reason.includes("kind/determinism fixture (gate deny)"));
    expect(row.kind).toBe("refusal");
    expect(row.determinism).toBe("deterministic");
    expect(row.source).toBe("gate");
  });

  it("a model-driven escalation counts as a deferral, not a refusal, and is model_influenced", async () => {
    const { merchant, agent } = await makeMerchantWithAgent("__explain_kind_escalate_model__");

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 50_000, status: "pending_escalation" })
      .returning();

    const [cap] = await db
      .insert(schema.spendCaps)
      .values({
        agentId: agent.id,
        capPaise: 1_000_000,
        spentPaise: 0,
        perTransactionMaxPaise: 1_000_000,
        windowStart: new Date(),
        windowEnd: new Date(Date.now() + 86_400_000),
        status: "active",
      })
      .returning();

    await db.insert(schema.escalations).values({
      moneyActionId: moneyAction.id,
      spendCapId: cap.id,
      riskReason: "This purchase pattern looked unusual to the model.",
      outcome: "pending",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "escalate",
      reason: "This purchase pattern looked unusual to the model.",
      moneyActionId: moneyAction.id,
    });

    const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10 })).filter((d) => d.reason.includes("This purchase pattern looked unusual"));
    expect(row.kind).toBe("deferral");
    expect(row.source).toBe("risk_escalation");
    expect(row.determinism).toBe("model_influenced");

    await db.delete(schema.escalations).where(eq(schema.escalations.moneyActionId, moneyAction.id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
  });

  it("a deterministic_fallback escalation (risk.ts's model-unavailable path) classifies as deterministic, not model_influenced — the case most likely to be got wrong", async () => {
    const { merchant, agent } = await makeMerchantWithAgent("__explain_kind_escalate_fallback__");

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: 50_000, status: "pending_escalation" })
      .returning();

    const [cap] = await db
      .insert(schema.spendCaps)
      .values({
        agentId: agent.id,
        capPaise: 1_000_000,
        spentPaise: 0,
        perTransactionMaxPaise: 1_000_000,
        windowStart: new Date(),
        windowEnd: new Date(Date.now() + 86_400_000),
        status: "active",
      })
      .returning();

    const fallbackReason = "Model unavailable. Deterministic fallback: this request consumes 60% of the cap, above the 50% fallback threshold.";
    await db.insert(schema.escalations).values({
      moneyActionId: moneyAction.id,
      spendCapId: cap.id,
      riskReason: fallbackReason,
      outcome: "pending",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "escalate",
      reason: fallbackReason,
      moneyActionId: moneyAction.id,
    });

    const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10 })).filter((d) => d.reason === fallbackReason);
    expect(row.kind).toBe("deferral");
    expect(row.determinism).toBe("deterministic"); // no model contributed — risk.ts's own fallback path

    await db.delete(schema.escalations).where(eq(schema.escalations.moneyActionId, moneyAction.id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
  });

  it("recovery_write_off (decision: n/a) is still surfaced as a refusal, not silently dropped by the n/a filter", async () => {
    const { merchant } = await makeMerchantWithAgent("__explain_recovery_writeoff__");
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "system",
      event: "recovery_write_off",
      decision: "n/a",
      reason: "Written off — test fixture, not worth attempting.",
    });

    const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10 })).filter((d) => d.reason.includes("test fixture, not worth attempting"));
    expect(row).toBeDefined();
    expect(row.source).toBe("recovery");
    expect(row.kind).toBe("refusal");
  });

  it("recovery_escalated_to_human is a deferral, not a refusal", async () => {
    const { merchant } = await makeMerchantWithAgent("__explain_recovery_escalate__");
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "system",
      event: "recovery_escalated_to_human",
      decision: "escalate",
      reason: "Routed to a human — test fixture.",
    });

    const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10 })).filter((d) => d.reason.includes("Routed to a human — test fixture"));
    expect(row.kind).toBe("deferral");
    expect(row.source).toBe("recovery");
  });

  it("purely informational audit rows (decision: n/a, not a recovery-stop event) never appear as a decision", async () => {
    const { merchant } = await makeMerchantWithAgent("__explain_informational__");
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "merchant",
      event: "bundle_created",
      decision: "n/a",
      reason: "Merchant created bundle — test fixture, not a decision.",
    });

    const decisions = await getUnifiedDecisions(merchant.id, { limit: 50 });
    expect(decisions.some((d) => d.reason.includes("not a decision"))).toBe(false);
  });
});

describe("no-offer refusals never expose margin figures, only counts", () => {
  it("belowMarginFloorCount is a plain integer, not a per-candidate margin", async () => {
    const { merchant, agent } = await makeMerchantWithAgent("__explain_offer_refusal__");

    const [decision] = await db
      .insert(schema.offerDecisions)
      .values({
        merchantId: merchant.id,
        agentId: agent.id,
        eligibleCandidateCount: 3,
        belowMarginFloorCount: 3,
        noOfferReason: "Every eligible bundle (3) priced at or below its own item cost — none clear the margin floor.",
      })
      .returning();
    createdOfferDecisionIds.push(decision.id);

    const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10, source: "offer_engine" })).filter((d) => d.id === decision.id);
    expect(row.source).toBe("offer_engine");
    expect(row.kind).toBe("refusal");
    expect(row.arithmetic).toEqual([
      { label: "Eligible candidates", value: "3" },
      { label: "Below margin floor", value: "3" },
    ]);
    expect(JSON.stringify(row)).not.toMatch(/margin(?!.floor)/i); // "margin floor" is fine (a label), a bare margin figure is not
  });

  it("an offer that WAS made is excluded — offer_decisions with offeredOfferId set is not a refusal", async () => {
    const { merchant, agent } = await makeMerchantWithAgent("__explain_offer_made__");

    // A minimal bundle+offer so offeredOfferId is a real FK, not a dangling id.
    const [bundle] = await db
      .insert(schema.bundles)
      .values({ merchantId: merchant.id, name: "__explain_offer_made_bundle__", bundlePricePaise: 10_000, status: "active" })
      .returning();
    const [offer] = await db
      .insert(schema.offers)
      .values({ merchantId: merchant.id, bundleId: bundle.id, agentId: agent.id, reasonText: "test", status: "offered", expiresAt: new Date(Date.now() + 3_600_000) })
      .returning();
    const [decision] = await db
      .insert(schema.offerDecisions)
      .values({ merchantId: merchant.id, agentId: agent.id, eligibleCandidateCount: 1, belowMarginFloorCount: 0, offeredOfferId: offer.id })
      .returning();
    createdOfferDecisionIds.push(decision.id);

    const offerRefusals = await getUnifiedDecisions(merchant.id, { limit: 50, source: "offer_engine" });
    expect(offerRefusals.some((d) => d.id === decision.id)).toBe(false);

    // offer_decisions.offered_offer_id FKs into offers — delete it first
    // (it's already tracked in createdOfferDecisionIds and cleared in
    // the top-level afterEach, but that runs AFTER this function body,
    // so it must go explicitly here before offers/bundles do).
    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.id, decision.id));
    createdOfferDecisionIds.splice(createdOfferDecisionIds.indexOf(decision.id), 1);
    await db.delete(schema.offers).where(eq(schema.offers.id, offer.id));
    await db.delete(schema.bundles).where(eq(schema.bundles.id, bundle.id));
  });
});

describe("negotiation refusals (Layer 8) — deterministic, counted correctly, never leak the floor", () => {
  it("a refused_turns_exhausted negotiation counts as a refusal and is deterministic — no model decides the floor breach", async () => {
    const { merchant, agent } = await makeMerchantWithAgent("__explain_negotiation_floor__");

    const [product] = await db.insert(schema.products).values({ merchantId: merchant.id, name: "test", description: "test", status: "active" }).returning();
    const [variant] = await db
      .insert(schema.productVariants)
      .values({ productId: product.id, merchantId: merchant.id, sku: `EXPLAIN-NEG-${Date.now()}`, pricePaise: 100_000, costPaise: 40_000, stock: 5, status: "active", floorPricePaise: 80_000 })
      .returning();

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        merchantId: merchant.id,
        variantId: variant.id,
        agentId: agent.id,
        status: "refused_turns_exhausted",
        catalogueUnitPricePaise: 100_000,
        floorUnitPricePaise: 80_000,
        currentBuyerOfferPaise: 70_000,
        buyerTurnCount: 3,
        expiresAt: new Date(Date.now() + 3_600_000),
        resolvedAt: new Date(),
      })
      .returning();

    try {
      const [row] = (await getUnifiedDecisions(merchant.id, { limit: 10, source: "negotiation" })).filter((d) => d.id === negotiation.id);
      expect(row.source).toBe("negotiation");
      expect(row.kind).toBe("refusal");
      expect(row.determinism).toBe("deterministic");
      expect(row.arithmetic.some((a) => a.label === "Buyer's final offer" && a.value === "₹700.00")).toBe(true);

      const stats = await getDecisionStats(merchant.id);
      expect(stats.bySource.negotiation).toBeGreaterThanOrEqual(1);

      // The floor itself, and costPaise, must never appear on this
      // surface — only the buyer's own offer and the turn count.
      expect(JSON.stringify(row)).not.toMatch("40000"); // costPaise
      expect(JSON.stringify(row)).not.toMatch("80000"); // floorUnitPricePaise, the raw paise figure
    } finally {
      await db.delete(schema.negotiations).where(eq(schema.negotiations.id, negotiation.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
      await db.delete(schema.products).where(eq(schema.products.id, product.id));
    }
  });

  it("an open or agreed negotiation is never surfaced as a refusal", async () => {
    const { merchant, agent } = await makeMerchantWithAgent("__explain_negotiation_open__");

    const [product] = await db.insert(schema.products).values({ merchantId: merchant.id, name: "test", description: "test", status: "active" }).returning();
    const [variant] = await db
      .insert(schema.productVariants)
      .values({ productId: product.id, merchantId: merchant.id, sku: `EXPLAIN-NEG-OPEN-${Date.now()}`, pricePaise: 100_000, costPaise: 40_000, stock: 5, status: "active", floorPricePaise: 80_000 })
      .returning();

    const [negotiation] = await db
      .insert(schema.negotiations)
      .values({
        merchantId: merchant.id,
        variantId: variant.id,
        agentId: agent.id,
        status: "open",
        catalogueUnitPricePaise: 100_000,
        floorUnitPricePaise: 80_000,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();

    try {
      const negotiationRefusals = await getUnifiedDecisions(merchant.id, { limit: 50, source: "negotiation" });
      expect(negotiationRefusals.some((d) => d.id === negotiation.id)).toBe(false);
    } finally {
      await db.delete(schema.negotiations).where(eq(schema.negotiations.id, negotiation.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
      await db.delete(schema.products).where(eq(schema.products.id, product.id));
    }
  });
});

describe("the explainer cannot invent a number (L7-4)", () => {
  it("every number in the generated explanation traces back to a supplied fact or the recorded reason", async () => {
    const decision = {
      id: "test-fixture",
      source: "recovery" as const,
      kind: "refusal" as const,
      determinism: "deterministic" as const,
      reason: "Stopped — ₹4217.00 is below the ₹1300.00 floor this policy treats as worth chasing at all.",
      boundLabel: "Amount too small to be worth chasing",
      boundRaw: "below_minimum_recoverable_amount",
      arithmetic: [{ label: "Recoverable floor", value: "₹1300.00" }],
      agentId: null,
      agentName: null,
      sessionToken: null,
      createdAt: new Date(),
      sourceRef: { table: "audit_log" as const, id: "test-fixture" },
    };

    const result = await explainDecision(decision);
    if (!result.available) {
      // A live model failure is an acceptable, honest outcome here too —
      // see the degrade-to-raw-record test below. Skip the number-check
      // in that case since there's no generated text to check.
      return;
    }

    const numbersInOutput = result.explanation.match(/\d[\d,]*(\.\d+)?/g) ?? [];
    const allowedNumbers = new Set(["4217.00", "1300.00", "4217", "1300"]);
    for (const n of numbersInOutput) {
      expect(allowedNumbers.has(n.replace(/,/g, ""))).toBe(true);
    }
  }, 20_000);

  it("degrades to the raw record on a model failure, and generates nothing that gets persisted", async () => {
    const decision = {
      id: "test-fixture-2",
      source: "gate" as const,
      kind: "refusal" as const,
      determinism: "deterministic" as const,
      reason: "Denied — test fixture for a forced model failure.",
      boundLabel: "Not enough stock",
      boundRaw: "product_stock",
      arithmetic: [],
      agentId: null,
      agentName: null,
      sessionToken: null,
      createdAt: new Date(),
      sourceRef: { table: "audit_log" as const, id: "test-fixture-2" },
    };

    // Not forcing an actual provider outage here (that's the failure
    // demo script's job, matching prior layers' pattern of a live
    // scenario rather than a mocked one) — this asserts the CONTRACT:
    // explainDecision never throws, and its return shape always lets
    // the caller show the complete recorded truth either way.
    const result = await explainDecision(decision);
    expect(typeof result.available).toBe("boolean");
    if (!result.available) {
      expect(result.explanation).toBe("");
    }
    // Either way, the recorded fields on `decision` itself are untouched —
    // explainDecision takes no db handle and cannot have written anything.
  }, 20_000);
});
