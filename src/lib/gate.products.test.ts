import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * L4-1: the catalogue as a real bound in the gate — price comes from the
 * product row, never the caller, and stock is decremented atomically the
 * same way spend_caps.spentPaise already is. Same no-mocks standard as
 * gate.test.ts: real DB, real Razorpay test-mode orders.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__gate_products_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `gate_products_test_${Date.now()}_${Math.random()}@test.invalid`,
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
    .values({
      merchantId,
      name: "__gate_products_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
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

async function makeProduct(merchantId: string, opts: Partial<typeof schema.products.$inferInsert> = {}) {
  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId,
      name: "__test product__",
      description: "test",
      pricePaise: 85_000,
      costPaise: 40_000,
      stock: 10,
      status: "active",
      ...opts,
    })
    .returning();
  return product;
}

describe("attemptMoneyAction — product-bound purchases", () => {
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
      await db
        .delete(schema.escalations)
        .where(
          inArray(
            schema.escalations.spendCapId,
            db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds)),
          ),
        );
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    if (currentProductIds.length > 0) {
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

  it("denies when the caller's amountPaise disagrees with the catalogue price, before reserving budget", async () => {
    const { merchantId, agent } = await setup();
    const product = await makeProduct(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 90_000, // disagrees with the catalogue's 85,000
      context: "House Blend Espresso",
      productId: product.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/catalogue price/i);

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    expect(cap.spentPaise).toBe(0);

    const [updatedProduct] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(updatedProduct.stock).toBe(5);
  });

  it("denies a zero-stock purchase with boundApplied product_stock, before reserving budget", async () => {
    const { merchantId, agent } = await setup();
    const product = await makeProduct(merchantId, { pricePaise: 85_000, stock: 0 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "House Blend Espresso",
      productId: product.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/stock/i);

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    expect(cap.spentPaise).toBe(0);
  });

  it("denies a cross-merchant product purchase by id enumeration", async () => {
    const { merchantId: merchantAId, agent } = await setup();

    const merchantB = await makeMerchant();
    // merchantB's own id must be cleaned up too, but it has no agent, so
    // it isn't tracked by the shared afterEach — clean it up inline.
    const productOfB = await makeProduct(merchantB.id, { pricePaise: 85_000, stock: 5 });

    try {
      const result = await attemptMoneyAction({
        agentId: agent.id,
        merchantId: merchantAId,
        type: "order_create",
        amountPaise: 85_000,
        context: "someone else's product",
        productId: productOfB.id,
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/no product/i);
    } finally {
      await db.delete(schema.products).where(eq(schema.products.id, productOfB.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    }
  });

  it("allows a valid product purchase, decrements stock atomically, and records productId/quantity", async () => {
    const { merchantId, agent } = await setup();
    const product = await makeProduct(merchantId, { pricePaise: 85_000, stock: 5 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 170_000, // 85,000 x 2
      context: "House Blend Espresso",
      productId: product.id,
      quantity: 2,
    });

    expect(result.decision).toBe("allow");
    expect(result.razorpayOrderId).toMatch(/^order_/);

    const [updatedProduct] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(updatedProduct.stock).toBe(3);

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(action.productId).toBe(product.id);
    expect(action.quantity).toBe(2);
  }, 20_000);

  it("releases both budget and stock when Razorpay genuinely rejects the order", async () => {
    const { merchantId, agent } = await setup();
    // A price of 1 paisa clears the gate's own checks but Razorpay itself
    // rejects it as below its minimum order amount, after reservation.
    const product = await makeProduct(merchantId, { pricePaise: 1, stock: 5 });
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 1,
      context: "House Blend Espresso",
      productId: product.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/released/i);

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    expect(cap.spentPaise).toBe(0);

    const [updatedProduct] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(updatedProduct.stock).toBe(5);
  }, 20_000);

  it("under N concurrent purchases against stock for exactly M, allows exactly M", async () => {
    const { merchantId, agent } = await setup();
    // Stock for exactly 3. amountPaise kept tiny relative to the cap so
    // the race is purely on reserveStock's atomicity, not the spend cap.
    const product = await makeProduct(merchantId, { pricePaise: 10_000, stock: 3 });
    productIds.push(product.id);

    const attempts = Array.from({ length: 6 }, (_, i) =>
      attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 10_000,
        context: `concurrent buyer ${i}`,
        productId: product.id,
      }),
    );

    const results = await Promise.all(attempts);
    // "allow" or "escalate" both mean the stock reservation succeeded —
    // the risk layer is a genuinely non-deterministic model call (see
    // PROGRESS.md's note on gate.escalation.test.ts) that can turn a
    // reserved purchase into an escalation rather than a same-request
    // allow, without touching stock either way. What must be exact is
    // how many reservations succeeded, not which of those two labels
    // each one got.
    const reservedCount = results.filter((r) => r.decision === "allow" || r.decision === "escalate").length;
    const deniedCount = results.filter((r) => r.decision === "deny").length;

    expect(reservedCount).toBe(3);
    expect(deniedCount).toBe(3);

    const [updatedProduct] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(updatedProduct.stock).toBe(0);
  }, 30_000);
});
