import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { POST } from "./route";

/**
 * L4-4/L4-8: the first HTTP-level tests for the agent API. The gate
 * itself is well tested (gate.test.ts et al) but nothing previously
 * exercised the route handler in front of it — auth rejection, malformed
 * bodies, and the "a denial is HTTP 200" contract were all untested.
 * Route handlers are plain async functions here (App Router), so they're
 * called directly with a constructed NextRequest — no server needed. No
 * mocks: real DB, real Razorpay test-mode orders, same standard as
 * gate.test.ts.
 */

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/agent/purchase", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__purchase_route_test_${Date.now()}_${Math.random()}__`,
      email: `purchase_route_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgentWithCap(merchantId: string) {
  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__purchase_route_test_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();

  const now = new Date();
  await db.insert(schema.spendCaps).values({
    agentId: agent.id,
    capPaise: 10_000_000,
    spentPaise: 0,
    perTransactionMaxPaise: 10_000_000,
    windowStart: now,
    windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    status: "active",
  });

  return { agent, rawKey };
}

async function makeProductWithVariant(merchantId: string) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__route test product__", description: "test", status: "active" })
    .returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `route-test-${Date.now()}`,
      pricePaise: 50_000,
      costPaise: 20_000,
      stock: 10,
      status: "active",
    })
    .returning();
  return { product, variant };
}

describe("POST /api/agent/purchase", () => {
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

    if (currentAgentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("rejects a request with no Authorization header, 401", async () => {
    const res = await POST(request({ amountPaise: 100, context: "test" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/api key/i);
  });

  it("rejects a request with an invalid key, 401", async () => {
    const res = await POST(request({ amountPaise: 100, context: "test" }, { authorization: "Bearer sk_not_a_real_key" }));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed JSON body, 400", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const req = new NextRequest("http://localhost/api/agent/purchase", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rawKey}` },
      body: "{not valid json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects a body missing both productId and amountPaise/context, 400", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const res = await POST(request({}, { authorization: `Bearer ${rawKey}` }));
    expect(res.status).toBe(400);
  });

  it("a denial is HTTP 200 with decision: deny in the body, not an error status", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    // No spend cap at all — a guaranteed deny.
    const rawKey = generateApiKey();
    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__no_cap_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
      .returning();
    agentIds.push(agent.id);

    const res = await POST(request({ amountPaise: 10_000, context: "test" }, { authorization: `Bearer ${rawKey}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("deny");
    expect(body.reason).toMatch(/no spend cap/i);
  });

  it("v1 shape (amountPaise + context, no productId) still allows a valid purchase", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const res = await POST(request({ amountPaise: 20_000, context: "a v1-style purchase" }, { authorization: `Bearer ${rawKey}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("allow");
    expect(body.razorpayOrderId).toMatch(/^order_/);
  }, 20_000);

  it("v2 shape: variantId alone buys the catalogue product at its real price", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);
    const { product, variant } = await makeProductWithVariant(merchant.id);
    productIds.push(product.id);

    const res = await POST(request({ variantId: variant.id }, { authorization: `Bearer ${rawKey}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("allow");

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, body.moneyActionId));
    expect(action.amountPaise).toBe(variant.pricePaise);
    expect(action.variantId).toBe(variant.id);
  }, 20_000);

  it("v2 shape: an asserted amountPaise that disagrees with the catalogue price is denied, HTTP 200", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);
    const { product, variant } = await makeProductWithVariant(merchant.id);
    productIds.push(product.id);

    const res = await POST(
      request({ variantId: variant.id, amountPaise: variant.pricePaise - 1 }, { authorization: `Bearer ${rawKey}` }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("deny");
    expect(body.reason).toMatch(/catalogue price/i);
  });

  it("replays the original outcome for a repeated idempotencyKey rather than double-charging", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const idempotencyKey = `test-key-${Date.now()}`;
    const firstRes = await POST(
      request({ amountPaise: 20_000, context: "idempotent test", idempotencyKey }, { authorization: `Bearer ${rawKey}` }),
    );
    const firstBody = await firstRes.json();

    const secondRes = await POST(
      request({ amountPaise: 20_000, context: "idempotent test", idempotencyKey }, { authorization: `Bearer ${rawKey}` }),
    );
    const secondBody = await secondRes.json();

    expect(secondRes.status).toBe(200);
    expect(secondBody.moneyActionId).toBe(firstBody.moneyActionId);
    expect(secondBody.reason).toMatch(/idempotent replay/i);
  }, 20_000);
});
