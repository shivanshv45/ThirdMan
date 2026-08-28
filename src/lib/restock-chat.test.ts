import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { handleChatTurn, newSessionToken } from "@/lib/chat";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 11-5: the chat's out-of-stock -> restock-alert offer. A separate
 * file from chat.test.ts (not appended to it) because this needs its own
 * cleanup of customer_contacts/restock_requests, which chat.test.ts's
 * afterEach doesn't know about — same "new file per feature area"
 * pattern as contacts.test.ts and notifications/policy.test.ts.
 *
 * The one thing under test that matters: a genuinely resolved,
 * genuinely zero-stock variant offers an alert; an UNRESOLVABLE product
 * (a typo, something not carried) never does — those are different
 * states and conflating them tells a customer their typo is out of
 * stock, which plans/layer-11-notifications-and-token-rewards.md's L11-5
 * calls out explicitly.
 */

const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const conversations = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
    const conversationIds = conversations.map((c) => c.id);
    if (conversationIds.length > 0) {
      await db.delete(schema.chatMessages).where(inArray(schema.chatMessages.conversationId, conversationIds));
      await db.delete(schema.cartItems).where(inArray(schema.cartItems.conversationId, conversationIds));
    }

    const contacts = await db.select({ id: schema.customerContacts.id }).from(schema.customerContacts).where(eq(schema.customerContacts.merchantId, merchantId));
    const contactIds = contacts.map((c) => c.id);
    if (contactIds.length > 0) {
      await db.delete(schema.restockRequests).where(inArray(schema.restockRequests.contactId, contactIds));
      await db.delete(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.contactId, contactIds));
    }
    await db.delete(schema.customerContacts).where(eq(schema.customerContacts.merchantId, merchantId));

    await db.delete(schema.offerDecisions).where(eq(schema.offerDecisions.merchantId, merchantId));
    await db.delete(schema.offers).where(eq(schema.offers.merchantId, merchantId));

    await db.delete(schema.conversations).where(eq(schema.conversations.merchantId, merchantId));
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

async function makeMerchantWithOutOfStockProduct() {
  const merchant = await createTestMerchant("__restock_chat_test__");
  createdMerchantIds.push(merchant.id);

  const [product] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Test Sold Out Roast", description: "A test product with zero stock.", status: "active" })
    .returning();
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product.id, merchantId: merchant.id, sku: `restock-test-${Date.now()}`, pricePaise: 40_000, costPaise: 15_000, stock: 0, status: "active" })
    .returning();

  return { merchant, product, variant };
}

describe("chat — out-of-stock restock offer (Layer 11-5)", () => {
  it("offers a restock alert for a genuinely resolved, zero-stock product, and records a real request once an email is given", async () => {
    const { merchant, variant } = await makeMerchantWithOutOfStockProduct();
    const sessionToken = newSessionToken();

    const offerTurn = await handleChatTurn(merchant.id, sessionToken, "add the test sold out roast");
    expect(offerTurn.restockOffer?.state).toBe("offered");
    expect(offerTurn.cart.lines.length).toBe(0); // never added to the cart — it's out of stock

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.sessionToken, sessionToken));
    expect(conversation.pendingRestockVariantId).toBe(variant.id);

    const confirmTurn = await handleChatTurn(merchant.id, sessionToken, "yes please, email me at restock-test@example.com");
    expect(confirmTurn.restockOffer?.state).toBe("recorded");

    const [clearedConversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.sessionToken, sessionToken));
    expect(clearedConversation.pendingRestockVariantId).toBeNull();

    const [contact] = await db.select().from(schema.customerContacts).where(eq(schema.customerContacts.merchantId, merchant.id));
    expect(contact.address).toBe("restock-test@example.com");
    expect(contact.consentSource).toBe("chat_restock_request");

    const [request] = await db.select().from(schema.restockRequests).where(eq(schema.restockRequests.variantId, variant.id));
    expect(request.status).toBe("waiting");
    expect(request.contactId).toBe(contact.id);
  }, 60_000);

  it("an unresolvable product (not in the catalogue) is never offered a restock alert", async () => {
    const { merchant } = await makeMerchantWithOutOfStockProduct();
    const sessionToken = newSessionToken();

    const result = await handleChatTurn(merchant.id, sessionToken, "do you have any dinosaur-shaped mugs");

    expect(result.restockOffer).toBeNull();

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.sessionToken, sessionToken));
    expect(conversation.pendingRestockVariantId).toBeNull();
  }, 30_000);

  it("moving on to something else clears a stale pending restock offer", async () => {
    const { merchant } = await makeMerchantWithOutOfStockProduct();
    const sessionToken = newSessionToken();

    await handleChatTurn(merchant.id, sessionToken, "add the test sold out roast");
    const [midway] = await db.select().from(schema.conversations).where(eq(schema.conversations.sessionToken, sessionToken));
    expect(midway.pendingRestockVariantId).not.toBeNull();

    await handleChatTurn(merchant.id, sessionToken, "actually never mind, what's your return policy?");

    const [after] = await db.select().from(schema.conversations).where(eq(schema.conversations.sessionToken, sessionToken));
    expect(after.pendingRestockVariantId).toBeNull();
  }, 60_000);
});
