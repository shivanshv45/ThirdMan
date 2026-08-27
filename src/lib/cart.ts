import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * The buyer chat's real, multi-item cart (Layer 9-close-out). cart_items
 * is live and buyer-editable right up until checkout — this module is
 * the only place cart lines are read, written, or resolved into what the
 * gate will actually charge. Same discipline as discount.ts's offers:
 * a caller may reference a cart by conversationId, but the amount it
 * must pay is always re-derived here from the live catalogue, never
 * trusted from the request.
 */

export interface CartLine {
  variantId: string;
  quantity: number;
  unitPricePaise: number;
  sku: string;
}

export interface ResolvedCart {
  conversationId: string;
  amountPaise: number;
  lines: CartLine[];
}

export interface CartResolutionFailure {
  reason: string;
  boundApplied: string;
}

/** Adds a variant to the cart, or increases its quantity if already present. Never called directly by the model — see chat.ts's applyIntent. */
export async function addCartItem(conversationId: string, variantId: string, quantity: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(schema.cartItems)
    .where(and(eq(schema.cartItems.conversationId, conversationId), eq(schema.cartItems.variantId, variantId)));

  if (existing) {
    await db
      .update(schema.cartItems)
      .set({ quantity: existing.quantity + quantity })
      .where(eq(schema.cartItems.id, existing.id));
    return;
  }

  await db.insert(schema.cartItems).values({ conversationId, variantId, quantity });
}

/** Sets a cart line's quantity to an absolute value. A quantity of 0 or less removes the line entirely — there is no "quantity: 0" row state. */
export async function setCartItemQuantity(conversationId: string, variantId: string, quantity: number): Promise<void> {
  if (quantity <= 0) {
    await removeCartItem(conversationId, variantId);
    return;
  }

  const [existing] = await db
    .select()
    .from(schema.cartItems)
    .where(and(eq(schema.cartItems.conversationId, conversationId), eq(schema.cartItems.variantId, variantId)));

  if (existing) {
    await db.update(schema.cartItems).set({ quantity }).where(eq(schema.cartItems.id, existing.id));
  } else {
    await db.insert(schema.cartItems).values({ conversationId, variantId, quantity });
  }
}

export async function removeCartItem(conversationId: string, variantId: string): Promise<void> {
  await db
    .delete(schema.cartItems)
    .where(and(eq(schema.cartItems.conversationId, conversationId), eq(schema.cartItems.variantId, variantId)));
}

export async function clearCart(conversationId: string): Promise<void> {
  await db.delete(schema.cartItems).where(eq(schema.cartItems.conversationId, conversationId));
}

export interface CartLineView extends CartLine {
  productId: string;
  name: string;
  stock: number;
}

/** Reads the live cart with each line's current catalogue price/stock — what the chat widget and checkout summary display. Never the source of truth for what checkout actually charges; resolveCartForRequest re-derives that independently at attempt time. */
export async function getCart(conversationId: string): Promise<{ lines: CartLineView[]; subtotalPaise: number }> {
  const items = await db.select().from(schema.cartItems).where(eq(schema.cartItems.conversationId, conversationId));
  if (items.length === 0) return { lines: [], subtotalPaise: 0 };

  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.status, "active")));
  const byId = new Map(variants.map((v) => [v.id, v]));
  const products = await db.select().from(schema.products);
  const productNameById = new Map(products.map((p) => [p.id, p.name]));

  const lines: CartLineView[] = [];
  for (const item of items) {
    const variant = byId.get(item.variantId);
    if (!variant) continue; // archived/deleted since being added — silently excluded from display, same as an offer's bundle item losing stock
    // Falls back to the SKU only if the parent product row is somehow
    // missing — the product name is what a buyer actually recognises.
    // A finer "Name (attribute)" distinction for multi-variant products
    // is chat.ts's own describeVariant, applied one layer up where the
    // full catalogue (with attributes) is already in scope.
    lines.push({
      variantId: variant.id,
      productId: variant.productId,
      name: productNameById.get(variant.productId) ?? variant.sku,
      quantity: item.quantity,
      unitPricePaise: variant.pricePaise,
      sku: variant.sku,
      stock: variant.stock,
    });
  }

  const subtotalPaise = lines.reduce((sum, l) => sum + l.unitPricePaise * l.quantity, 0);
  return { lines, subtotalPaise };
}

/** Resolves a merchant + browser sessionToken into the conversation row cart_items keys against — the identity every other buyer-chat surface (offers, negotiations) already uses, so checkout never needs a separate conversationId exposed to the client. */
export async function getConversationBySession(merchantId: string, sessionToken: string) {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.merchantId, merchantId), eq(schema.conversations.sessionToken, sessionToken)));
  return conversation ?? null;
}

/**
 * Resolves a conversation's live cart into what the gate will actually
 * charge and reserve: re-reads every line fresh from product_variants
 * (price and stock), computes the total from scratch, and denies if the
 * cart is empty or any line's variant no longer exists/is inactive. The
 * caller's asserted amountPaise (checked one level up in gate.ts, same
 * as offerId/negotiationId) must match this total exactly.
 */
export async function resolveCartForCheckout(
  merchantId: string,
  conversationId: string,
): Promise<{ cart?: ResolvedCart; failure?: CartResolutionFailure }> {
  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (!conversation || conversation.merchantId !== merchantId) {
    return { failure: { reason: `Denied — no cart found for this merchant.`, boundApplied: "cart_exists" } };
  }

  const items = await db.select().from(schema.cartItems).where(eq(schema.cartItems.conversationId, conversationId));
  if (items.length === 0) {
    return { failure: { reason: "Denied — the cart is empty. Nothing to check out.", boundApplied: "cart_not_empty" } };
  }

  const lines: CartLine[] = [];
  let amountPaise = 0;
  for (const item of items) {
    const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, item.variantId));
    if (!variant || variant.merchantId !== merchantId || variant.status !== "active") {
      return {
        failure: {
          reason: `Denied — a cart item (variant ${item.variantId}) is no longer available. Remove it and try again.`,
          boundApplied: "cart_item_active",
        },
      };
    }
    if (variant.stock < item.quantity) {
      return {
        failure: {
          reason: `Denied — "${variant.sku}" has ${variant.stock} in stock, but the cart wants ${item.quantity}.`,
          boundApplied: "cart_item_stock",
        },
      };
    }
    lines.push({ variantId: variant.id, quantity: item.quantity, unitPricePaise: variant.pricePaise, sku: variant.sku });
    amountPaise += variant.pricePaise * item.quantity;
  }

  return { cart: { conversationId, amountPaise, lines } };
}

/** Writes the frozen cart_purchases/cart_purchase_items snapshot the gate references from money_actions.cartId — see schema.ts's comment on why this can't just point at the live cart_items rows. */
export async function snapshotCartPurchase(merchantId: string, cart: ResolvedCart): Promise<string> {
  const [purchase] = await db
    .insert(schema.cartPurchases)
    .values({ merchantId, conversationId: cart.conversationId })
    .returning();

  await db.insert(schema.cartPurchaseItems).values(
    cart.lines.map((line) => ({
      cartPurchaseId: purchase.id,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
    })),
  );

  return purchase.id;
}

/** Loads a frozen cart purchase's lines by its snapshot id, for the gate paths that need to release stock against an already-settled cart purchase (an escalation rejection, a failed execution) without re-deriving from the live (possibly since-changed) cart. */
export async function loadCartPurchaseItems(cartId: string): Promise<{ variantId: string; quantity: number }[]> {
  const items = await db.select().from(schema.cartPurchaseItems).where(eq(schema.cartPurchaseItems.cartPurchaseId, cartId));
  return items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
}
