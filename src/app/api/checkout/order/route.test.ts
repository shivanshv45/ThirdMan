import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { POST } from "./route";

/**
 * Layer 26-5/26-7: a retried checkout POST (a flaky mobile connection's
 * own retry, a double-submit) must produce ONE order, not two —
 * verified against the real route handler and the real gate's own
 * idempotency mechanism (gate contract point 7), not a mock. Same
 * "call the real handler directly with a constructed NextRequest, no
 * server needed" pattern agent/purchase/route.test.ts already uses.
 */

function request(body: unknown) {
  return new NextRequest("http://localhost/api/checkout/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const cleanupMerchantIds: string[] = [];

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__checkout_idempotency_test_${Date.now()}_${Math.random()}__`,
      email: `checkout_idempotency_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  cleanupMerchantIds.push(merchant.id);
  return merchant;
}

async function makeProductWithVariant(merchantId: string) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__checkout idempotency test product__", description: "test", status: "active" })
    .returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `checkout-idempotency-${Date.now()}`,
      pricePaise: 50_000,
      costPaise: 20_000,
      stock: 50,
      status: "active",
    })
    .returning();
  return { product, variant };
}

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const merchantId = cleanupMerchantIds.pop()!;
    const storefrontAgent = await getOrCreateStorefrontAgent(merchantId);
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    await db.delete(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId));
    await db.delete(schema.products).where(eq(schema.products.merchantId, merchantId));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, storefrontAgent.id));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
}, 20_000);

describe("POST /api/checkout/order — idempotency", () => {
  it("two requests sharing an idempotencyKey produce exactly one money action and one Razorpay order", async () => {
    const merchant = await makeMerchant();
    const { product, variant } = await makeProductWithVariant(merchant.id);
    const idempotencyKey = randomUUID();

    const body = { merchantId: merchant.id, productId: product.id, variantId: variant.id, quantity: 1, idempotencyKey };

    const res1 = await POST(request(body));
    const json1 = await res1.json();
    expect(json1.error).toBeUndefined();
    expect(json1.moneyActionId).toBeTruthy();

    const res2 = await POST(request(body));
    const json2 = await res2.json();
    expect(json2.error).toBeUndefined();

    // Same money action, same Razorpay order — a replay, not a second
    // reservation and a second Razorpay call.
    expect(json2.moneyActionId).toBe(json1.moneyActionId);
    expect(json2.razorpayOrderId).toBe(json1.razorpayOrderId);

    const rows = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchant.id));
    expect(rows).toHaveLength(1);

    // Stock decremented exactly once, not twice.
    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(49);
  }, 20_000);

  it("two requests with DIFFERENT idempotency keys are two independent purchases", async () => {
    const merchant = await makeMerchant();
    const { product, variant } = await makeProductWithVariant(merchant.id);

    const res1 = await POST(request({ merchantId: merchant.id, productId: product.id, variantId: variant.id, quantity: 1, idempotencyKey: randomUUID() }));
    const json1 = await res1.json();
    const res2 = await POST(request({ merchantId: merchant.id, productId: product.id, variantId: variant.id, quantity: 1, idempotencyKey: randomUUID() }));
    const json2 = await res2.json();

    expect(json1.moneyActionId).toBeTruthy();
    expect(json2.moneyActionId).toBeTruthy();
    expect(json2.moneyActionId).not.toBe(json1.moneyActionId);

    const rows = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchant.id));
    expect(rows).toHaveLength(2);
  }, 20_000);

  it("no idempotencyKey at all still works (backward compatible with a direct API caller)", async () => {
    const merchant = await makeMerchant();
    const { product, variant } = await makeProductWithVariant(merchant.id);

    const res = await POST(request({ merchantId: merchant.id, productId: product.id, variantId: variant.id, quantity: 1 }));
    const json = await res.json();

    expect(json.error).toBeUndefined();
    expect(json.moneyActionId).toBeTruthy();
  }, 20_000);
});
