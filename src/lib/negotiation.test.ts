import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { openNegotiation, submitBuyerCounter, getOpenNegotiationForIdentity, resolveNegotiation, MAX_BUYER_COUNTERS } from "@/lib/negotiation";
import { attemptMoneyAction } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 8: the negotiation floor must be unbreakable by the model, and
 * provably so — see plans/layer-8-negotiation.md, "The one rule" and the
 * layer's closing bar. These tests are the load-bearing ones for the
 * whole layer; everything else is supporting.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__negotiation_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `negotiation_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__negotiation_test_agent__", apiKeyHash: `test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

async function makeCap(agentId: string, opts: Partial<typeof schema.spendCaps.$inferInsert> = {}) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise: 10_000_000,
      spentPaise: 0,
      perTransactionMaxPaise: 10_000_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
      ...opts,
    })
    .returning();
  return cap;
}

async function makeVariant(merchantId: string, opts: Partial<typeof schema.productVariants.$inferInsert> = {}) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__negotiation_test_product__", description: "test", status: "active" })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `NEG-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pricePaise: 100_000,
      costPaise: 40_000,
      stock: 10,
      status: "active",
      ...opts,
    })
    .returning();

  return { product, variant };
}

describe("negotiation — the floor cannot be breached", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  let productIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    const currentProductIds = productIds;
    merchantId = undefined;
    agentIds = [];
    productIds = [];

    // FK dependency order, checked against the actual references() calls
    // in schema.ts before writing this, per FAILURES.md's standing
    // lesson (L1-2/L3-6/L6-1): money_actions.negotiationId -> negotiations,
    // negotiation_turns.negotiationId -> negotiations, negotiations.agentId
    // -> agents, negotiations.variantId -> product_variants.
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));

    const negotiationIds = (
      await db.select({ id: schema.negotiations.id }).from(schema.negotiations).where(eq(schema.negotiations.merchantId, currentMerchantId))
    ).map((n) => n.id);
    if (negotiationIds.length > 0) {
      await db.delete(schema.negotiationTurns).where(inArray(schema.negotiationTurns.negotiationId, negotiationIds));
    }
    await db.delete(schema.negotiations).where(eq(schema.negotiations.merchantId, currentMerchantId));

    if (currentAgentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
      await db.delete(schema.agents).where(inArray(schema.agents.id, currentAgentIds));
    }
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function setup() {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    await makeCap(agent.id);
    return { merchantId, agent };
  }

  it("a variant with no floor set is not negotiable at all", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { floorPricePaise: null });
    productIds.push(product.id);

    const { negotiation, refusalReason } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });

    expect(negotiation).toBeUndefined();
    expect(refusalReason).toContain("not negotiable");
  });

  it("a buyer counter below the floor is refused, never agreed — even repeated across the full turn budget", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    expect(negotiation).toBeDefined();

    let last;
    for (let i = 0; i < MAX_BUYER_COUNTERS; i++) {
      last = await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 70_000); // always below the 80,000 floor
      if (i < MAX_BUYER_COUNTERS - 1) {
        expect(last.outcome).toBe("countered");
        expect(last.negotiation.status).toBe("open");
      }
    }

    expect(last!.outcome).toBe("refused");
    expect(last!.negotiation.status).toBe("refused_turns_exhausted");
    expect(last!.negotiation.agreedUnitPricePaise).toBeNull();

    // The refusal is real and durable: resolving it against the gate
    // must be impossible, since there is no agreed price to redeem.
    const resolved = await resolveNegotiation(merchantId, negotiation!.id, { agentId: agent.id });
    expect(resolved.failure).toBeDefined();
    expect(resolved.failure!.boundApplied).toContain("negotiation_status");
  });

  it("a buyer counter exactly at the floor is agreed immediately — the boundary is inclusive", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    const result = await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 80_000);

    expect(result.outcome).toBe("agreed");
    expect(result.negotiation.agreedUnitPricePaise).toBe(80_000);
  });

  it("a buyer counter one paisa below the floor is never agreed", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    const result = await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 79_999);

    expect(result.outcome).not.toBe("agreed");
  });

  it("the merchant's counter is never below the floor, across the full turn budget", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });

    let current = negotiation!;
    for (let i = 0; i < MAX_BUYER_COUNTERS; i++) {
      const result = await submitBuyerCounter(current.id, merchantId, { agentId: agent.id }, 1); // buyer always lowballs at 1 paisa
      current = result.negotiation;
      if (current.currentMerchantCounterPaise !== null) {
        expect(current.currentMerchantCounterPaise).toBeGreaterThanOrEqual(80_000);
      }
    }
  });

  it("only one open negotiation exists per buyer identity per variant", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const first = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    const second = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });

    expect(first.negotiation).toBeDefined();
    expect(second.negotiation).toBeUndefined();
    expect(second.refusalReason).toContain("already open");
  });

  it("an agreed price is re-derived at redemption, never trusted from the request — a mismatched amount is denied", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    const agreed = await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 90_000);
    expect(agreed.outcome).toBe("agreed");

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 50_000, // the caller asserting a different, lower amount than the real agreed price
      context: "negotiated purchase, wrong amount",
      negotiationId: negotiation!.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agreed price");
  });

  it("a purchase referencing a different buyer's agreed negotiation is denied", async () => {
    const { merchantId, agent } = await setup();
    const otherAgent = await makeAgent(merchantId);
    agentIds.push(otherAgent.id);
    await makeCap(otherAgent.id);

    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 90_000);

    const result = await attemptMoneyAction({
      agentId: otherAgent.id,
      merchantId,
      type: "order_create",
      amountPaise: 90_000,
      context: "negotiated purchase, wrong buyer",
      negotiationId: negotiation!.id,
    });

    expect(result.decision).toBe("deny");
  });

  it("a valid agreed negotiation redeems as a real, gated purchase — allow, real order, negotiation marked redeemed", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000, stock: 5 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    const agreed = await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 85_000);
    expect(agreed.outcome).toBe("agreed");

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "negotiated purchase",
      negotiationId: negotiation!.id,
    });

    expect(result.decision).toBe("allow");
    expect(result.razorpayOrderId).toBeDefined();

    // Redeemed — a second attempt against the same negotiation must fail,
    // since resolveNegotiation only accepts status "agreed".
    const secondAttempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "negotiated purchase, replay",
      negotiationId: negotiation!.id,
    });
    expect(secondAttempt.decision).toBe("deny");

    const [row] = await db.select().from(schema.negotiations).where(eq(schema.negotiations.id, negotiation!.id));
    expect(row.status).toBe("redeemed");
  }, 30_000);

  it("a negotiated stock decrement is atomic — two concurrent redemptions of one unit of stock, exactly one succeeds", async () => {
    const { merchantId, agent } = await setup();
    const otherAgent = await makeAgent(merchantId);
    agentIds.push(otherAgent.id);
    await makeCap(otherAgent.id);

    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 50_000, stock: 1 });
    productIds.push(product.id);

    const { negotiation: negA } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    const { negotiation: negB } = await openNegotiation(merchantId, variant.id, 1, { agentId: otherAgent.id });

    const agreedA = await submitBuyerCounter(negA!.id, merchantId, { agentId: agent.id }, 50_000);
    const agreedB = await submitBuyerCounter(negB!.id, merchantId, { agentId: otherAgent.id }, 50_000);
    expect(agreedA.outcome).toBe("agreed");
    expect(agreedB.outcome).toBe("agreed");

    const [resultA, resultB] = await Promise.all([
      attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 50_000,
        context: "concurrent negotiated purchase A",
        negotiationId: negA!.id,
      }),
      attemptMoneyAction({
        agentId: otherAgent.id,
        merchantId,
        type: "order_create",
        amountPaise: 50_000,
        context: "concurrent negotiated purchase B",
        negotiationId: negB!.id,
      }),
    ]);

    const decisions = [resultA.decision, resultB.decision];
    expect(decisions.filter((d) => d === "allow").length).toBe(1);
    expect(decisions.filter((d) => d === "deny").length).toBe(1);

    const [finalVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(finalVariant.stock).toBe(0);
  }, 30_000);

  it("a request naming both variantId and negotiationId is denied as ambiguous", async () => {
    const { merchantId, agent } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });
    await submitBuyerCounter(negotiation!.id, merchantId, { agentId: agent.id }, 90_000);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 90_000,
      context: "ambiguous request",
      variantId: variant.id,
      negotiationId: negotiation!.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("more than one");
  });

  it("cross-agent isolation by enumeration — an agent cannot continue a negotiation opened by a different agent, even with its real id", async () => {
    const { merchantId, agent } = await setup();
    const otherAgent = await makeAgent(merchantId);
    agentIds.push(otherAgent.id);
    await makeCap(otherAgent.id);

    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    const { negotiation } = await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });

    await expect(submitBuyerCounter(negotiation!.id, merchantId, { agentId: otherAgent.id }, 90_000)).rejects.toThrow(/different buyer/i);
  });

  it("getOpenNegotiationForIdentity is scoped to the exact buyer identity and variant — enumeration, not empty-list", async () => {
    const { merchantId, agent } = await setup();
    const otherAgent = await makeAgent(merchantId);
    agentIds.push(otherAgent.id);
    await makeCap(otherAgent.id);

    const { product, variant } = await makeVariant(merchantId, { pricePaise: 100_000, floorPricePaise: 80_000 });
    productIds.push(product.id);

    await openNegotiation(merchantId, variant.id, 1, { agentId: agent.id });

    const found = await getOpenNegotiationForIdentity(merchantId, variant.id, { agentId: agent.id });
    const notFound = await getOpenNegotiationForIdentity(merchantId, variant.id, { agentId: otherAgent.id });

    expect(found).not.toBeNull();
    expect(notFound).toBeNull();
  });
});
