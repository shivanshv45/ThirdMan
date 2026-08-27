import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { addCartItem } from "@/lib/cart";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 9-close-out: a genuine multi-item cart purchase must pass
 * through the gate re-deriving its total from the live catalogue, never
 * a caller-asserted amount — the same product_price_match discipline
 * gate.products.test.ts proves for a single variant and
 * gate.offers.test.ts proves for a merchant-authored bundle. A cart is
 * the ad-hoc, buyer-authored equivalent: multiple distinct variants, one
 * order, the total always the live sum of real catalogue prices.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__gate_cart_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `gate_cart_test_${Date.now()}_${Math.random()}@test.invalid`,
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
      name: "__gate_cart_test_agent__",
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

async function makeVariant(merchantId: string, opts: Partial<typeof schema.productVariants.$inferInsert> = {}) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__test product__", description: "test", status: "active" })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pricePaise: 50_000,
      costPaise: 20_000,
      stock: 10,
      status: "active",
      ...opts,
    })
    .returning();

  return { product, variant };
}

async function makeConversation(merchantId: string) {
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ merchantId, sessionToken: `test-session-${Date.now()}-${Math.random()}` })
    .returning();
  return conversation;
}

describe("attemptMoneyAction — cart-bound (multi-item) purchases", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  let productIds: string[] = [];
  let conversationIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    const currentProductIds = productIds;
    const currentConversationIds = conversationIds;
    merchantId = undefined;
    agentIds = [];
    productIds = [];
    conversationIds = [];

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
    // money_actions.cartId FKs into cart_purchases — must go before it.
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    if (currentConversationIds.length > 0) {
      const purchases = await db.select({ id: schema.cartPurchases.id }).from(schema.cartPurchases).where(inArray(schema.cartPurchases.conversationId, currentConversationIds));
      const purchaseIds = purchases.map((p) => p.id);
      if (purchaseIds.length > 0) {
        await db.delete(schema.cartPurchaseItems).where(inArray(schema.cartPurchaseItems.cartPurchaseId, purchaseIds));
      }
      await db.delete(schema.cartPurchases).where(inArray(schema.cartPurchases.conversationId, currentConversationIds));
      await db.delete(schema.cartItems).where(inArray(schema.cartItems.conversationId, currentConversationIds));
      await db.delete(schema.chatMessages).where(inArray(schema.chatMessages.conversationId, currentConversationIds));
      await db.delete(schema.conversations).where(inArray(schema.conversations.id, currentConversationIds));
    }
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
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
    const conversation = await makeConversation(merchantId);
    conversationIds.push(conversation.id);
    return { merchantId, agent, conversation };
  }

  it("allows a two-item cart at the exact sum of real catalogue prices", async () => {
    const { merchantId, agent, conversation } = await setup();
    const { product: productA, variant: variantA } = await makeVariant(merchantId, { pricePaise: 50_000, stock: 5 });
    const { product: productB, variant: variantB } = await makeVariant(merchantId, { pricePaise: 30_000, stock: 5 });
    productIds.push(productA.id, productB.id);

    await addCartItem(conversation.id, variantA.id, 2); // 2 x 500 = 1000
    await addCartItem(conversation.id, variantB.id, 1); // 1 x 300 = 300

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 130_000,
      context: "cart purchase",
      cartConversationId: conversation.id,
    });

    expect(result.decision).toBe("allow");

    const [moneyAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(moneyAction.cartId).not.toBeNull();

    const [variantAAfter] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantA.id));
    const [variantBAfter] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantB.id));
    expect(variantAAfter.stock).toBe(3); // 5 - 2
    expect(variantBAfter.stock).toBe(4); // 5 - 1
  });

  it("denies a cart purchase that asserts a total other than the live catalogue sum — the price bound holds for carts too", async () => {
    const { merchantId, agent, conversation } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 50_000, stock: 5 });
    productIds.push(product.id);

    await addCartItem(conversation.id, variant.id, 1);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 10_000, // a "discount" the caller invented
      context: "cart purchase",
      cartConversationId: conversation.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("catalogue total");

    // Denied — no stock should have moved.
    const [variantAfter] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(variantAfter.stock).toBe(5);
  });

  it("denies checkout of an empty cart", async () => {
    const { merchantId, agent, conversation } = await setup();

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 1,
      context: "cart purchase",
      cartConversationId: conversation.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("empty");
  });

  it("denies a cart with insufficient stock on one line — an all-or-nothing bound, mirroring an offer's bundle", async () => {
    const { merchantId, agent, conversation } = await setup();
    const { product: productA, variant: variantA } = await makeVariant(merchantId, { pricePaise: 50_000, stock: 5 });
    const { product: productB, variant: variantB } = await makeVariant(merchantId, { pricePaise: 30_000, stock: 1 });
    productIds.push(productA.id, productB.id);

    await addCartItem(conversation.id, variantA.id, 2);
    await addCartItem(conversation.id, variantB.id, 3); // only 1 in stock

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 190_000,
      context: "cart purchase",
      cartConversationId: conversation.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("stock");

    // Neither line's stock should have moved — all-or-nothing.
    const [variantAAfter] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantA.id));
    expect(variantAAfter.stock).toBe(5);
  });

  it("denies referencing both a variantId and a cart in the same request — ambiguous target", async () => {
    const { merchantId, agent, conversation } = await setup();
    const { product, variant } = await makeVariant(merchantId, { pricePaise: 50_000, stock: 5 });
    productIds.push(product.id);
    await addCartItem(conversation.id, variant.id, 1);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 50_000,
      context: "ambiguous",
      variantId: variant.id,
      cartConversationId: conversation.id,
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("more than one");
  });

  it("denies checking out another merchant's cart by conversation id", async () => {
    const { merchantId, agent } = await setup();
    const otherMerchant = await makeMerchant();

    try {
      const otherConversation = await makeConversation(otherMerchant.id);
      const { product, variant } = await makeVariant(otherMerchant.id, { pricePaise: 50_000, stock: 5 });
      await addCartItem(otherConversation.id, variant.id, 1);

      const result = await attemptMoneyAction({
        agentId: agent.id,
        merchantId,
        type: "order_create",
        amountPaise: 50_000,
        context: "cross-merchant cart",
        cartConversationId: otherConversation.id,
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("no cart found");

      await db.delete(schema.cartItems).where(eq(schema.cartItems.conversationId, otherConversation.id));
      await db.delete(schema.conversations).where(eq(schema.conversations.id, otherConversation.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
      await db.delete(schema.products).where(eq(schema.products.id, product.id));
    } finally {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, otherMerchant.id));
    }
  });
});
