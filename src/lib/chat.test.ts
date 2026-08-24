import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { handleChatTurn, getConversationState, newSessionToken } from "@/lib/chat";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * L4-6: the buyer chat. No mocks — real Groq calls, same standard as
 * risk.ts's tests. What's under test is the deterministic half of the
 * split CLAUDE.md rule 2 requires: the cart's product id/quantity/price
 * are always computed in code from the real catalogue, never trusted
 * from the model's own words, however the model happens to phrase its
 * reply. The model's prose itself is not asserted on beyond a loose
 * sanity check, since exact wording is inherently non-deterministic.
 */

const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const conversations = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
    const conversationIds = conversations.map((c) => c.id);
    if (conversationIds.length > 0) {
      await db.delete(schema.chatMessages).where(inArray(schema.chatMessages.conversationId, conversationIds));
    }
    // conversations.cartProductId FKs into products, so conversations
    // must go before products, and products before merchants — same
    // FK-dependency-order lesson FAILURES.md documents elsewhere.
    await db.delete(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
  }

  if (createdProductIds.length > 0) {
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
      pricePaise: 50_000,
      costPaise: 20_000,
      stock: 10,
      status: "active",
    })
    .returning();
  createdProductIds.push(product.id);

  return { merchant, product };
}

describe("handleChatTurn — the AI/code split", () => {
  it("grounds a reply in the real catalogue and never invents a product", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const result = await handleChatTurn(merchant.id, newSessionToken(), "do you sell motor oil?");

    expect(result.cart).toBeNull();
    expect(result.reply.length).toBeGreaterThan(0);
  }, 20_000);

  it("adding a real product sets the cart from the catalogue's real price, not anything the model states", async () => {
    const { merchant, product } = await makeMerchantWithProduct();
    const result = await handleChatTurn(merchant.id, newSessionToken(), "add the test espresso blend to my cart");

    expect(result.cart).not.toBeNull();
    expect(result.cart!.product.id).toBe(product.id);
    expect(result.cart!.product.pricePaise).toBe(50_000);
    expect(result.cart!.subtotalPaise).toBe(result.cart!.quantity * 50_000);
  }, 20_000);

  it("a message naming no real product leaves the cart unchanged", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const sessionToken = newSessionToken();

    const first = await handleChatTurn(merchant.id, sessionToken, "add the test espresso blend");
    expect(first.cart).not.toBeNull();

    const second = await handleChatTurn(merchant.id, sessionToken, "what's the weather like today?");
    // An unrelated message must not clear or corrupt the existing cart.
    expect(second.cart?.product.id).toBe(first.cart!.product.id);
    expect(second.cart?.quantity).toBe(first.cart!.quantity);
  }, 30_000);

  it("the subtotal is always quantity * catalogue price, computed in code, across multiple turns", async () => {
    const { merchant } = await makeMerchantWithProduct();
    const sessionToken = newSessionToken();

    await handleChatTurn(merchant.id, sessionToken, "add the test espresso blend");
    const result = await handleChatTurn(merchant.id, sessionToken, "make it 3 instead");

    if (result.cart) {
      expect(result.cart.subtotalPaise).toBe(result.cart.quantity * result.cart.product.pricePaise);
    }
  }, 30_000);

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
    expect(state.cart).toBeNull();
  });
}, 60_000);
