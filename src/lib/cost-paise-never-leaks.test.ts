import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { getPublicCatalogue, getPublicProduct } from "@/lib/storefront-catalogue";
import { GET as agentProductsGET } from "@/app/api/agent/products/route";
import { POST as mcpPOST } from "@/app/api/mcp/route";
import { GET as manifestGET } from "@/app/store/[merchantId]/manifest.json/route";
import { runOfferEngine } from "@/lib/offer-engine";
import { getUnifiedDecisions, getDecisionStats, getDecisionById } from "@/lib/explainability";
import { explainDecision } from "@/lib/explain-decision";
import { MAX_BUYER_COUNTERS } from "@/lib/negotiation";

/**
 * L5-8's required consolidated check: costPaise is internal-only
 * (dashboard-mutations.ts's own comment says so) and must never appear
 * in ANY agent-facing or public shape, across every surface this layer
 * added or restructured. A per-surface spot-check already exists in each
 * surface's own test file; this asserts it once, directly, against every
 * surface together, so a future change that accidentally serializes a
 * variant row whole (which does carry costPaise) fails loudly here even
 * if no individual surface test happens to catch it.
 */

const COST_PAISE_MARKER = 987_654; // a value distinctive enough that any accidental leak is unmistakable

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId))));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId));
    await db.delete(schema.products).where(eq(schema.products.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function setupMerchantWithAgent() {
  const merchant = await createTestMerchant("__cost_leak_test__");
  createdMerchantIds.push(merchant.id);

  const [product] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Cost Leak Test Product", description: "test", status: "active" })
    .returning();
  await db.insert(schema.productVariants).values({
    productId: product.id,
    merchantId: merchant.id,
    sku: `COST-LEAK-${Date.now()}`,
    pricePaise: 50_000,
    costPaise: COST_PAISE_MARKER,
    stock: 5,
    status: "active",
  });

  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "__cost_leak_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();

  return { merchant, product, rawKey, agent };
}

describe("costPaise never leaks into any agent-facing or public surface", () => {
  it("getPublicCatalogue / getPublicProduct", async () => {
    const { merchant, product } = await setupMerchantWithAgent();

    const catalogue = await getPublicCatalogue(merchant.id);
    expect(JSON.stringify(catalogue)).not.toMatch(String(COST_PAISE_MARKER));

    const single = await getPublicProduct(merchant.id, product.id);
    expect(JSON.stringify(single)).not.toMatch(String(COST_PAISE_MARKER));
  });

  it("GET /api/agent/products", async () => {
    const { rawKey } = await setupMerchantWithAgent();
    const req = new NextRequest("http://localhost/api/agent/products", { headers: { authorization: `Bearer ${rawKey}` } });
    const res = await agentProductsGET(req);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(String(COST_PAISE_MARKER));
  });

  it("MCP list_products / get_product / search_products", async () => {
    const { rawKey, product } = await setupMerchantWithAgent();

    for (const call of [
      { name: "list_products", args: { pageSize: 50 } },
      { name: "get_product", args: { productId: product.id } },
      { name: "search_products", args: { query: "cost leak" } },
    ]) {
      const req = new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rawKey}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.name, arguments: call.args } }),
      });
      const res = await mcpPOST(req);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(String(COST_PAISE_MARKER));
    }
  });

  it("the public discovery manifest", async () => {
    const { merchant } = await setupMerchantWithAgent();
    const req = new NextRequest(`http://localhost/store/${merchant.id}/manifest.json`);
    const res = await manifestGET(req, { params: Promise.resolve({ merchantId: merchant.id }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(String(COST_PAISE_MARKER));
  });

  it("the offer engine's result (Layer 6-2) — a distinctive cost marker on the upsell candidate never reaches the returned offer or noOfferReason", async () => {
    const { merchant, product, agent } = await setupMerchantWithAgent();

    // A second variant whose cost carries the marker, bundled with the
    // first product — the engine computes margin from this internally
    // but must never let the number itself escape into anything the
    // buyer or the calling agent sees.
    const [secondProduct] = await db
      .insert(schema.products)
      .values({ merchantId: merchant.id, name: "Cost Leak Upsell Product", description: "test", status: "active" })
      .returning();
    const [upsellVariant] = await db
      .insert(schema.productVariants)
      .values({
        productId: secondProduct.id,
        merchantId: merchant.id,
        sku: `COST-LEAK-UPSELL-${Date.now()}`,
        pricePaise: 100_000,
        costPaise: COST_PAISE_MARKER,
        stock: 5,
        status: "active",
      })
      .returning();

    const [cartVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, product.id));

    const [bundle] = await db
      .insert(schema.bundles)
      .values({ merchantId: merchant.id, name: "__cost_leak_bundle__", bundlePricePaise: 130_000, status: "active" })
      .returning();
    await db.insert(schema.bundleItems).values({ bundleId: bundle.id, variantId: upsellVariant.id, quantity: 1 });

    try {
      const result = await runOfferEngine(merchant.id, cartVariant.id, { agentId: agent.id });
      expect(JSON.stringify(result)).not.toMatch(String(COST_PAISE_MARKER));
    } finally {
      await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchant.id));
      await db.delete(schema.offers).where(eq(schema.offers.merchantId, merchant.id));
      await db.delete(schema.bundleItems).where(eq(schema.bundleItems.bundleId, bundle.id));
      await db.delete(schema.bundles).where(eq(schema.bundles.id, bundle.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, upsellVariant.id));
      await db.delete(schema.products).where(eq(schema.products.id, secondProduct.id));
    }
  }, 20_000);

  it("the L7 explainability surface (getUnifiedDecisions/getDecisionStats/getDecisionById, and the decision explainer) — a real margin-floor refusal never exposes its cost figure through any of them", async () => {
    const { merchant, product, agent } = await setupMerchantWithAgent();
    const [cartVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, product.id));

    // A SEPARATE upsell variant, priced at exactly its own cost — a
    // bundle whose only item is the cart's own variant is never eligible
    // at all (offer-engine.ts's own filter), so this needs a second real
    // variant to reach the margin-floor check rather than the
    // eligibility check. Same zero-margin shape
    // scripts/demo-failure-upsell-refused.ts (L6-7) already proved out.
    // No live model dependency, so this can't flake on Groq quota the
    // way a live-ranking call could.
    const [explainSecondProduct] = await db
      .insert(schema.products)
      .values({ merchantId: merchant.id, name: "Cost Leak Explain Upsell Product", description: "test", status: "active" })
      .returning();
    const [explainUpsellVariant] = await db
      .insert(schema.productVariants)
      .values({
        productId: explainSecondProduct.id,
        merchantId: merchant.id,
        sku: `COST-LEAK-EXPLAIN-${Date.now()}`,
        pricePaise: COST_PAISE_MARKER,
        costPaise: COST_PAISE_MARKER,
        stock: 5,
        status: "active",
      })
      .returning();

    const [bundle] = await db
      .insert(schema.bundles)
      .values({ merchantId: merchant.id, name: "__cost_leak_explain_bundle__", bundlePricePaise: COST_PAISE_MARKER, status: "active" })
      .returning();
    await db.insert(schema.bundleItems).values({ bundleId: bundle.id, variantId: explainUpsellVariant.id, quantity: 1 });

    try {
      await runOfferEngine(merchant.id, cartVariant.id, { agentId: agent.id });

      const decisions = await getUnifiedDecisions(merchant.id, { limit: 50, source: "offer_engine" });
      expect(JSON.stringify(decisions)).not.toMatch(String(COST_PAISE_MARKER));

      const stats = await getDecisionStats(merchant.id);
      expect(JSON.stringify(stats)).not.toMatch(String(COST_PAISE_MARKER));

      const refusal = decisions.find((d) => d.source === "offer_engine");
      expect(refusal).toBeDefined();

      const byId = await getDecisionById(merchant.id, refusal!.id);
      expect(JSON.stringify(byId)).not.toMatch(String(COST_PAISE_MARKER));

      const explanation = await explainDecision(refusal!);
      expect(explanation.explanation).not.toMatch(String(COST_PAISE_MARKER));
    } finally {
      await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchant.id));
      await db.delete(schema.offers).where(eq(schema.offers.merchantId, merchant.id));
      await db.delete(schema.bundleItems).where(eq(schema.bundleItems.bundleId, bundle.id));
      await db.delete(schema.bundles).where(eq(schema.bundles.id, bundle.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, explainUpsellVariant.id));
      await db.delete(schema.products).where(eq(schema.products.id, explainSecondProduct.id));
    }
  }, 20_000);

  it("negotiation (Layer 8) — costPaise never reaches the MCP negotiate tool's output, the negotiation refusal record, or the unified explainability surface", async () => {
    const { merchant, rawKey, product } = await setupMerchantWithAgent();

    // The variant's costPaise carries the marker; its negotiation floor
    // is a completely separate, ordinary number — the whole point of
    // DECISIONS.md's "floor is a merchant-authored price, not a derived
    // margin" choice is that a negotiation never needs to touch cost at
    // all, so this is really asserting that nothing in the negotiation
    // path accidentally serializes the variant row whole.
    const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, product.id));
    await db.update(schema.productVariants).set({ floorPricePaise: 40_000 }).where(eq(schema.productVariants.id, variant.id));

    try {
      // Open via the real MCP tool call, same path a real agent uses.
      const openReq = new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rawKey}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "negotiate", arguments: { sku: variant.sku } } }),
      });
      const openRes = await mcpPOST(openReq);
      const openBody = await openRes.json();
      expect(JSON.stringify(openBody)).not.toMatch(String(COST_PAISE_MARKER));

      const negotiationId = JSON.parse(openBody.result.content[0].text).negotiationId;

      // Exhaust the turn budget with a lowball counter, forcing a real
      // recorded refusal, then check every surface that could leak cost.
      let counterBody;
      for (let i = 0; i < MAX_BUYER_COUNTERS; i++) {
        const counterReq = new NextRequest("http://localhost/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rawKey}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "negotiate", arguments: { negotiationId, offerUnitPricePaise: 100 } } }),
        });
        const counterRes = await mcpPOST(counterReq);
        counterBody = await counterRes.json();
        expect(JSON.stringify(counterBody)).not.toMatch(String(COST_PAISE_MARKER));
      }

      const decisions = await getUnifiedDecisions(merchant.id, { limit: 50, source: "negotiation" });
      expect(JSON.stringify(decisions)).not.toMatch(String(COST_PAISE_MARKER));

      const stats = await getDecisionStats(merchant.id);
      expect(JSON.stringify(stats)).not.toMatch(String(COST_PAISE_MARKER));

      const refusal = decisions.find((d) => d.source === "negotiation");
      expect(refusal).toBeDefined();
      const explanation = await explainDecision(refusal!);
      expect(explanation.explanation).not.toMatch(String(COST_PAISE_MARKER));
    } finally {
      await db.delete(schema.negotiationTurns).where(
        inArray(
          schema.negotiationTurns.negotiationId,
          db.select({ id: schema.negotiations.id }).from(schema.negotiations).where(eq(schema.negotiations.merchantId, merchant.id)),
        ),
      );
      await db.delete(schema.negotiations).where(eq(schema.negotiations.merchantId, merchant.id));
    }
  }, 30_000);
});
