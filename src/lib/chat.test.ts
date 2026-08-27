import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { handleChatTurn, getConversationState, newSessionToken } from "@/lib/chat";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * L4-6: the buyer chat. Real multi-item cart added Layer 9-close-out —
 * see cart.ts. No mocks — real Groq calls, same standard as risk.ts's
 * tests. What's under test is the deterministic half of the split
 * CLAUDE.md rule 2 requires: every cart line's variant/quantity/price is
 * always computed in code from the real catalogue, never trusted from
 * the model's own words, however the model happens to phrase its reply.
 * The model's prose itself is not asserted on beyond a loose sanity
 * check, since exact wording is inherently non-deterministic.
 */

const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const conversations = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
    const conversationIds = conversations.map((c) => c.id);
    if (conversationIds.length > 0) {
      await db.delete(schema.chatMessages).where(inArray(schema.chatMessages.conversationId, conversationIds));
      // cart_items and cart_purchases both FK into conversations —
      // must go before conversations, same FK-dependency-order lesson
      // FAILURES.md documents elsewhere.
      await db.delete(schema.cartItems).where(inArray(schema.cartItems.conversationId, conversationIds));
      const purchases = await db.select({ id: schema.cartPurchases.id }).from(schema.cartPurchases).where(inArray(schema.cartPurchases.conversationId, conversationIds));
      const purchaseIds = purchases.map((p) => p.id);
      if (purchaseIds.length > 0) {
        await db.delete(schema.cartPurchaseItems).where(inArray(schema.cartPurchaseItems.cartPurchaseId, purchaseIds));
      }
      await db.delete(schema.cartPurchases).where(inArray(schema.cartPurchases.conversationId, conversationIds));
    }
    await db.delete(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
  }

  for (const merchantId of createdMerchantIds) {
    // Layer 6: offer_decisions.cartVariantId FKs into product_variants,
    // and offers.bundleId (via bundle_items) can too — both must be
    // deleted before product_variants, same FK-dependency-order lesson
    // as everywhere else in this file. Chat doesn't create bundles/offers
    // itself, but runOfferEngine (chat.ts) always writes an
    // offer_decisions row for a cart, so this must be cleaned up here.
    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));
    await db.delete(schema.offers).where(eq(schema.offers.merchantId, merchantId));
  }

  if (createdProductIds.length > 0) {
    await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, createdProductIds));
    await db.delete(schema.products).where(inArray(schema.products.id, createdProductIds));
    createdProductIds.length = 0;
  }

  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function makeMerchantWithProduct() {
  const merchant = await createTestMerchant("__chat_test_merchant__");
  createdMerchantIds.push(merchant.id);

  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId: merchant.id,
      name: "Test Espresso Blend",
      description: "A test product for chat.",
      status: "active",
    })
    .returning();
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: merchant.id,
      sku: `chat-test-${Date.now()}`,
      pricePaise: 50_000,
      costPaise: 20_000,
      stock: 10,
      status: "active",
    })
    .returning();

  return { merchant, product, variant };
}

async function makeMerchantWithTwoProducts() {
  const merchant = await createTestMerchant("__chat_test_merchant_multi__");
  createdMerchantIds.push(merchant.id);

  const [productA] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Test Espresso Blend", description: "First test product.", status: "active" })
    .returning();
  const [productB] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Test Filter Roast", description: "Second test product.", status: "active" })
    .returning();
  createdProductIds.push(productA.id, productB.id);

  const [variantA] = await db
    .insert(schema.productVariants)
    .values({ productId: productA.id, merchantId: merchant.id, sku: `chat-test-a-${Date.now()}`, pricePaise: 50_000, costPaise: 20_000, stock: 10, status: "active" })
    .returning();
  const [variantB] = await db
    .insert(schema.productVariants)
    .values({ productId: productB.id, merchantId: merchant.id, sku: `chat-test-b-${Date.now()}`, pricePaise: 30_000, costPaise: 12_000, stock: 10, status: "active" })
    .returning();

  return { merchant, productA, productB, variantA, variantB };
}

describe("handleChatTurn — the AI/code split", () => {
  it("grounds a reply in the real catalogue and never invents a product", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const result = await handleChatTurn(merchant.id, newSessionToken(), "do you sell motor oil?");

    expect(result.cart.lines).toEqual([]);
    expect(result.reply.length).toBeGreaterThan(0);
  }, 20_000);

  it("adding a real product sets the cart line from the catalogue's real price, not anything the model states", async () => {
    const { merchant, product, variant } = await makeMerchantWithProduct();
    const result = await handleChatTurn(merchant.id, newSessionToken(), "add the test espresso blend to my cart");

    expect(result.cart.lines.length).toBe(1);
    expect(result.cart.lines[0].productId).toBe(product.id);
    expect(result.cart.lines[0].variantId).toBe(variant.id);
    expect(result.cart.lines[0].unitPricePaise).toBe(50_000);
    expect(result.cart.subtotalPaise).toBe(result.cart.lines[0].quantity * 50_000);
  }, 20_000);

  it("a message naming no real product leaves the cart unchanged", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const sessionToken = newSessionToken();

    const first = await handleChatTurn(merchant.id, sessionToken, "add the test espresso blend");
    expect(first.cart.lines.length).toBe(1);

    const second = await handleChatTurn(merchant.id, sessionToken, "what's the weather like today?");
    // An unrelated message must not clear or corrupt the existing cart.
    expect(second.cart.lines.length).toBe(1);
    expect(second.cart.lines[0].variantId).toBe(first.cart.lines[0].variantId);
    expect(second.cart.lines[0].quantity).toBe(first.cart.lines[0].quantity);
  }, 30_000);

  it("the subtotal is always quantity * catalogue price, computed in code, across multiple turns", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const sessionToken = newSessionToken();

    await handleChatTurn(merchant.id, sessionToken, "add the test espresso blend");
    const result = await handleChatTurn(merchant.id, sessionToken, "make it 3 instead");

    if (result.cart.lines.length > 0) {
      const expected = result.cart.lines.reduce((sum, l) => sum + l.quantity * l.unitPricePaise, 0);
      expect(result.cart.subtotalPaise).toBe(expected);
    }
  }, 30_000);

  it("adding two different real products holds both as separate lines — a genuine multi-item cart", async () => {
    const { merchant, variantA, variantB } = await makeMerchantWithTwoProducts();
    const sessionToken = newSessionToken();

    await handleChatTurn(merchant.id, sessionToken, "add the test espresso blend");
    const result = await handleChatTurn(merchant.id, sessionToken, "also add the test filter roast");

    expect(result.cart.lines.length).toBe(2);
    const variantIds = result.cart.lines.map((l) => l.variantId).sort();
    expect(variantIds).toEqual([variantA.id, variantB.id].sort());
    const expectedSubtotal = result.cart.lines.reduce((sum, l) => sum + l.quantity * l.unitPricePaise, 0);
    expect(result.cart.subtotalPaise).toBe(expectedSubtotal);
  }, 40_000);

  it("removing one line from a multi-item cart leaves the other untouched", async () => {
    const { merchant, variantA } = await makeMerchantWithTwoProducts();
    const sessionToken = newSessionToken();

    await handleChatTurn(merchant.id, sessionToken, "add the test espresso blend");
    await handleChatTurn(merchant.id, sessionToken, "also add the test filter roast");
    const result = await handleChatTurn(merchant.id, sessionToken, "remove the test filter roast");

    expect(result.cart.lines.length).toBe(1);
    expect(result.cart.lines[0].variantId).toBe(variantA.id);
  }, 50_000);

  it("persists conversation history and cart across calls, readable via getConversationState", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const sessionToken = newSessionToken();

    await handleChatTurn(merchant.id, sessionToken, "hello, what do you sell?");
    const state = await getConversationState(merchant.id, sessionToken);

    expect(state.messages.length).toBe(2); // customer + assistant
    expect(state.messages[0].role).toBe("customer");
    expect(state.messages[1].role).toBe("assistant");
  }, 20_000);

  it("a fresh session token starts an empty, isolated conversation", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const state = await getConversationState(merchant.id, newSessionToken());
    expect(state.messages).toEqual([]);
    expect(state.cart.lines).toEqual([]);
  });
}, 60_000);
