import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { complete, completeStructured } from "@/lib/llm";
import { getPublicCatalogue, type PublicProduct } from "@/lib/storefront-catalogue";
import { formatPaise } from "@/lib/money";
import { z } from "zod";

/**
 * The buyer chat (Layer 4-6). The split CLAUDE.md rule 2 requires:
 *
 * - The LLM does discovery, conversation, and recommendation. It reads
 *   the real catalogue (grounded, never invents a product) and proposes
 *   a structured intent — it never writes to the cart, computes a price,
 *   or decides a purchase is allowed.
 * - Code resolves that intent against the real catalogue (id, price,
 *   stock), applies it to conversations.cartProductId/cartQuantity, and
 *   is the only thing that ever states a rupee figure. If the model
 *   states a price in its reply, it's a price code already put in front
 *   of it as a fact, not one it computed.
 * - Checkout itself goes through the existing gate — this module never
 *   creates a Razorpay order or money_actions row.
 */

const intentSchema = z.object({
  action: z.enum(["add_to_cart", "set_quantity", "remove_from_cart", "none"]),
  /** The product name as the customer referred to it — resolved against the real catalogue in code, never trusted as an id. */
  productName: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
});

type ChatIntent = z.infer<typeof intentSchema>;

export interface ChatTurnResult {
  reply: string;
  cart: { product: PublicProduct; quantity: number; subtotalPaise: number } | null;
}

async function getOrCreateConversation(merchantId: string, sessionToken: string) {
  const [existing] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.merchantId, merchantId), eq(schema.conversations.sessionToken, sessionToken)));

  if (existing) return existing;

  const [created] = await db
    .insert(schema.conversations)
    .values({ merchantId, sessionToken })
    .returning();
  return created;
}

export function newSessionToken(): string {
  return randomUUID();
}

async function getHistory(conversationId: string) {
  return db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.conversationId, conversationId))
    .orderBy(asc(schema.chatMessages.createdAt))
    .limit(20);
}

/** Fuzzy-resolves a model-proposed product name against the real catalogue. Never trusts the name as authoritative — only ever used to look up a real row. */
function resolveProductByName(catalogue: PublicProduct[], name: string): PublicProduct | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;

  const exact = catalogue.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact;

  const contains = catalogue.find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()));
  if (contains) return contains;

  // Loose word-overlap match for phrasing like "the ethiopia one".
  const needleWords = needle.split(/\s+/).filter((w) => w.length > 2);
  let best: PublicProduct | null = null;
  let bestScore = 0;
  for (const product of catalogue) {
    const productWords = product.name.toLowerCase().split(/\s+/);
    const score = needleWords.filter((w) => productWords.some((pw) => pw.includes(w))).length;
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }
  return bestScore > 0 ? best : null;
}

async function classifyIntent(
  message: string,
  catalogue: PublicProduct[],
  currentCart: { product: PublicProduct; quantity: number } | null,
): Promise<ChatIntent> {
  const catalogueList = catalogue.map((p) => `- ${p.name}: ${formatPaise(p.pricePaise)}, ${p.stock} in stock`).join("\n");
  const cartContext = currentCart
    ? `The customer's cart currently has ${currentCart.quantity} x "${currentCart.product.name}". A message like "make it N" or "just one" refers to changing this item's quantity (set_quantity), not adding a new product.`
    : "The customer's cart is currently empty.";

  try {
    const { data } = await completeStructured({
      prompt: `A customer is chatting with a coffee shop's storefront assistant. Given their latest message, decide if they want to add, change the quantity of, or remove an item from their cart, referring only to products in this real catalogue:\n${catalogueList}\n\n${cartContext}\n\nCustomer message: "${message}"\n\nIf they name a product not in this list, or their intent is unclear, respond with action "none". For set_quantity, productName may be null if it clearly refers to the current cart item.`,
      schema: intentSchema,
      schemaDescription: `{"action": "add_to_cart"|"set_quantity"|"remove_from_cart"|"none", "productName": string|null, "quantity": number|null}`,
    });
    return data;
  } catch (err) {
    // A model failure on intent classification degrades to "did nothing"
    // — never guesses a purchase intent it couldn't actually classify.
    console.warn("[chat] intent classification failed, treating as no cart change:", err);
    return { action: "none", productName: null, quantity: null };
  }
}

/** Applies a classified intent to the cart, resolving productName against the real catalogue. The model's proposal is advisory only — every field here is re-validated before being written. */
async function applyIntent(
  conversation: typeof schema.conversations.$inferSelect,
  intent: ChatIntent,
  catalogue: PublicProduct[],
): Promise<void> {
  if (intent.action === "remove_from_cart") {
    await db.update(schema.conversations).set({ cartProductId: null, cartQuantity: 1 }).where(eq(schema.conversations.id, conversation.id));
    return;
  }

  if (intent.action === "set_quantity" && conversation.cartProductId) {
    const quantity = intent.quantity && intent.quantity > 0 ? intent.quantity : 1;
    await db.update(schema.conversations).set({ cartQuantity: quantity }).where(eq(schema.conversations.id, conversation.id));
    return;
  }

  if (intent.action === "add_to_cart" && intent.productName) {
    const product = resolveProductByName(catalogue, intent.productName);
    if (!product || product.stock <= 0) return; // unresolvable or out of stock — leave the cart unchanged, the reply below explains it wasn't found
    const quantity = intent.quantity && intent.quantity > 0 ? intent.quantity : 1;
    await db
      .update(schema.conversations)
      .set({ cartProductId: product.id, cartQuantity: quantity })
      .where(eq(schema.conversations.id, conversation.id));
  }
}

async function loadCart(conversation: typeof schema.conversations.$inferSelect, catalogue: PublicProduct[]) {
  if (!conversation.cartProductId) return null;
  const product = catalogue.find((p) => p.id === conversation.cartProductId);
  if (!product) return null;
  return { product, quantity: conversation.cartQuantity, subtotalPaise: product.pricePaise * conversation.cartQuantity };
}

/**
 * Handles one chat turn: classifies intent, applies it deterministically,
 * then asks the model for a natural-language reply grounded in the real
 * catalogue and the (already-updated, code-computed) cart. The model is
 * handed the cart as a fact string it may reference, never asked to
 * compute or restate a total on its own.
 */
export async function handleChatTurn(
  merchantId: string,
  sessionToken: string,
  customerMessage: string,
): Promise<ChatTurnResult> {
  const conversation = await getOrCreateConversation(merchantId, sessionToken);
  const catalogue = await getPublicCatalogue(merchantId);

  await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "customer", content: customerMessage });

  const cartBeforeIntent = await loadCart(conversation, catalogue);
  const intent = await classifyIntent(customerMessage, catalogue, cartBeforeIntent);
  await applyIntent(conversation, intent, catalogue);

  const [updatedConversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
  const cart = await loadCart(updatedConversation, catalogue);

  const history = await getHistory(conversation.id);
  const historyText = history.map((m) => `${m.role === "customer" ? "Customer" : "Assistant"}: ${m.content}`).join("\n");
  const catalogueList = catalogue.map((p) => `- ${p.name}: ${formatPaise(p.pricePaise)} — ${p.description} (${p.stock > 0 ? `${p.stock} in stock` : "out of stock"})`).join("\n");
  const cartFact = cart
    ? `SYSTEM FACT — the customer's cart currently holds EXACTLY ${cart.quantity} unit(s) of "${cart.product.name}", subtotal ${formatPaise(cart.subtotalPaise)}. This number (${cart.quantity}) is authoritative and final. If you mention the cart, you must state exactly "${cart.quantity}" — never a different number, even if the conversation earlier suggested otherwise.`
    : "SYSTEM FACT — the customer's cart is currently empty.";

  let reply: string;
  try {
    const { text } = await complete({
      systemPrompt: `You are a friendly storefront assistant for a coffee shop. You may only discuss products in this real catalogue — never invent a product or state a price other than what's given to you:\n${catalogueList}\n\nBe concise, warm, and helpful. If asked about a product not in the catalogue, say plainly that it isn't carried. Never state a total, price, or cart quantity other than one explicitly given to you as a SYSTEM FACT.\n\n${cartFact}`,
      prompt: `Conversation so far:\n${historyText}\n\nRespond to the customer's latest message. If you reference the cart, its quantity must match the SYSTEM FACT exactly.`,
    });
    reply = text.trim();
  } catch (err) {
    console.warn("[chat] reply generation failed:", err);
    reply = "Sorry, I'm having trouble responding right now — please try again in a moment.";
  }

  await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });

  return { reply, cart };
}

export async function getConversationState(merchantId: string, sessionToken: string): Promise<{
  messages: { role: "customer" | "assistant"; content: string }[];
  cart: { product: PublicProduct; quantity: number; subtotalPaise: number } | null;
}> {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.merchantId, merchantId), eq(schema.conversations.sessionToken, sessionToken)));

  if (!conversation) return { messages: [], cart: null };

  const catalogue = await getPublicCatalogue(merchantId);
  const [messages, cart] = await Promise.all([getHistory(conversation.id), loadCart(conversation, catalogue)]);

  return { messages: messages.map((m) => ({ role: m.role, content: m.content })), cart };
}
