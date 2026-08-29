import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { complete, completeStructured } from "@/lib/llm";
import { getPublicCatalogue, type PublicProduct } from "@/lib/storefront-catalogue";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { runOfferEngine, getOpenOfferForIdentity } from "@/lib/offer-engine";
import { openNegotiation, submitBuyerCounter, getOpenNegotiationForIdentity, MAX_BUYER_COUNTERS } from "@/lib/negotiation";
import { addCartItem, setCartItemQuantity, removeCartItem, getCart, type CartLineView } from "@/lib/cart";
import { requestRestockAlert } from "@/lib/restock";
import { normalizeEmail } from "@/lib/contacts";
import { inspectInbound } from "@/lib/model-armor";
import { z } from "zod";

/**
 * The buyer chat (Layer 4-6, real multi-item cart added Layer
 * 9-close-out). The split CLAUDE.md rule 2 requires:
 *
 * - The LLM does discovery, conversation, and recommendation. It reads
 *   the real catalogue (grounded, never invents a product) and proposes
 *   a structured intent — it never writes to the cart, computes a price,
 *   or decides a purchase is allowed.
 * - Code resolves that intent against the real catalogue (id, price,
 *   stock), applies it via cart.ts, and is the only thing that ever
 *   states a rupee figure. If the model states a price in its reply,
 *   it's a price code already put in front of it as a fact, not one it
 *   computed.
 * - Checkout itself goes through the existing gate — this module never
 *   creates a Razorpay order or money_actions row.
 */

const intentSchema = z.object({
  action: z.enum(["add_to_cart", "set_quantity", "remove_from_cart", "counter_offer", "provide_contact", "none"]),
  /** The product name as the customer referred to it — resolved against the real catalogue in code, never trusted as an id. */
  productName: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  /**
   * Layer 8: only meaningful for action "counter_offer" — the per-unit
   * rupee price the customer proposed ("would you do ₹9 each?"). Parsed
   * by the model from natural language, but re-validated as a real
   * integer against the real variant in code before it ever reaches the
   * negotiation engine — the model proposes, code applies, same split
   * applyIntent already uses for cart lines.
   */
  counterUnitPriceRupees: z.number().positive().nullable(),
  /**
   * Layer 11-5: only meaningful for action "provide_contact" — an email
   * address the model extracted from a reply to a restock offer. This
   * is advisory only, exactly like productName: re-validated through
   * contacts.ts's normalizeEmail in code before it's ever stored. Never
   * trusted as already-valid just because the model produced it.
   */
  contactEmail: z.string().nullable(),
});

type ChatIntent = z.infer<typeof intentSchema>;

export interface ChatCartLine {
  variantId: string;
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPricePaise: number;
  subtotalPaise: number;
}

export interface ChatTurnResult {
  reply: string;
  /** Every line currently in the cart (Layer 9-close-out: genuinely multi-item, not one product/variant). Empty array, never null, when the cart has nothing in it. */
  cart: { lines: ChatCartLine[]; subtotalPaise: number };
  /** Layer 6-3: at most one open upsell offer for this cart, if the engine found one. Never present without a cart. */
  offer: { offerId: string; bundleName: string; amountPaise: number; reasonText: string } | null;
  /**
   * Layer 8: the most-recently-touched cart line's open negotiation, if
   * one exists — the client reads this to know whether to show a
   * "propose a price" UI and, once status is "agreed", a checkout button
   * that buys at that exact price via negotiationId. Negotiation is
   * still per-variant (see negotiation.ts) — with a multi-item cart, it
   * applies to whichever single line the customer is actively
   * negotiating, not the whole cart at once.
   */
  negotiation: {
    negotiationId: string;
    status: (typeof schema.negotiationStatusEnum.enumValues)[number];
    catalogueUnitPricePaise: number;
    agreedUnitPricePaise: number | null;
    buyerTurnsUsed: number;
    buyerTurnsAllowed: number;
  } | null;
  /**
   * Layer 11-5: whether this turn is offering (or just recorded) a
   * restock alert for an out-of-stock item the customer asked about.
   * "offered" means the reply is asking for an email; the client has no
   * special UI obligation here — the whole flow is conversational, this
   * is only exposed for the client to optionally show a hint.
   */
  restockOffer: { state: "offered" | "recorded"; variantName: string } | null;
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

/**
 * The cart's flattened view of one purchasable variant for chat purposes
 * (Layer 5-7). "id" is the variant's own id, not the product's — the
 * cart is still single-line (conversations.cartProductId/cartQuantity
 * hold one product+its resolved variant at a time; a genuine multi-line
 * cart is a real gap, not built here, see plans/layer-5-agent-readable-catalog.md).
 * name folds in a distinguishing attribute when the product has more
 * than one variant, e.g. "Ethiopia Yirgacheffe (250g)" vs "(1kg)", so the
 * model's reply and the cart display read unambiguously.
 */
interface ChatProduct {
  id: string;
  productId: string;
  name: string;
  description: string;
  sku: string;
  pricePaise: number;
  stock: number;
}

function describeVariant(product: PublicProduct, variant: PublicProduct["variants"][number]): string {
  const attrs = Object.values(variant.attributes);
  if (product.variants.length <= 1 || attrs.length === 0) return product.name;
  return `${product.name} (${attrs.join(", ")})`;
}

function toChatProducts(catalogue: PublicProduct[]): ChatProduct[] {
  return catalogue.flatMap((p) =>
    p.variants.map((v) => ({
      id: v.id,
      productId: p.id,
      name: describeVariant(p, v),
      description: p.description,
      sku: v.sku,
      pricePaise: v.pricePaise,
      stock: v.stock,
    })),
  );
}

/**
 * Resolves a model-proposed product/variant reference against the real
 * catalogue — never trusts it as an id, only ever used to look up a real
 * row. Tries, in order: exact SKU match (an agent-savvy customer or a
 * copy-pasted SKU), exact name match, then a word-overlap score computed
 * against BOTH the display name and the variant's own attribute values —
 * so "the 250g ethiopia" resolves by attribute, not just by how much of
 * the product name string overlaps (Layer 5-7's actual improvement over
 * L4-6's name-only matching).
 */
function resolveProductByName(catalogue: ChatProduct[], name: string): ChatProduct | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;

  const skuMatch = catalogue.find((p) => p.sku.toLowerCase() === needle);
  if (skuMatch) return skuMatch;

  const exact = catalogue.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact;

  const contains = catalogue.find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()));
  if (contains) return contains;

  // Loose word-overlap match for phrasing like "the 250g ethiopia one" —
  // scored against the full display name, which already folds in the
  // distinguishing attribute values from describeVariant above.
  const needleWords = needle.split(/\s+/).filter((w) => w.length > 2);
  let best: ChatProduct | null = null;
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
  catalogue: ChatProduct[],
  currentCart: { lines: CartLineView[] },
  awaitingRestockEmail: boolean,
): Promise<ChatIntent> {
  const catalogueList = catalogue.map((p) => `- ${p.name}: ${formatPaise(p.pricePaise)}, ${p.stock} in stock`).join("\n");
  const cartContext =
    currentCart.lines.length > 0
      ? `The customer's cart currently has: ${currentCart.lines.map((l) => `${l.quantity} x "${l.name}"`).join(", ")}. A message like "make it N" or "remove the coffee" refers to changing or removing one of THESE existing lines (name the product in productName so code knows which line) — it is never a new product unless the customer clearly names one not already in the cart.`
      : "The customer's cart is currently empty.";
  const restockContext = awaitingRestockEmail
    ? ` The assistant just offered to email the customer when an out-of-stock item is back — if this message looks like an email address or a "yes, use my email" reply, classify it as action "provide_contact" with contactEmail set to the address. A clear "no" or an unrelated message is NOT provide_contact.`
    : "";

  try {
    const { data } = await completeStructured({
      prompt: `A customer is chatting with a coffee shop's storefront assistant. Given their latest message, decide if they want to add, change the quantity of, or remove an item from their cart (which may already hold several different products), propose a lower price for one specific cart item (a real, per-unit rupee counter-offer, e.g. "would you do ₹9 each?" or "I'll pay 8.50"), or provide an email address for a restock alert, referring only to products in this real catalogue:\n${catalogueList}\n\n${cartContext}${restockContext}\n\nCustomer message: "${message}"\n\nIMPORTANT: if the customer asks to add/order/buy a product that IS in the list above, respond with action "add_to_cart" and its productName EVEN IF the list shows it as out of stock — whether it can actually be added is decided by code afterward, not by you; do not pre-empt that by responding "none" just because you see it's out of stock. Only respond with action "none" if the product isn't in the list at all, or their intent is genuinely unclear. productName should always be given when the customer's message refers to a specific product or cart line — for set_quantity/remove_from_cart/counter_offer, it identifies WHICH line, and may only be omitted if the cart has exactly one line and the reference is unambiguous. For counter_offer, counterUnitPriceRupees must be the exact per-unit rupee number they proposed — never invent one. For provide_contact, contactEmail must be the exact address they gave — never invent or guess one.`,
      schema: intentSchema,
      schemaDescription: `{"action": "add_to_cart"|"set_quantity"|"remove_from_cart"|"counter_offer"|"provide_contact"|"none", "productName": string|null, "quantity": number|null, "counterUnitPriceRupees": number|null, "contactEmail": string|null}`,
    });
    return data;
  } catch (err) {
    // A model failure on intent classification degrades to "did nothing"
    // — never guesses a purchase intent it couldn't actually classify.
    console.warn("[chat] intent classification failed, treating as no cart change:", err);
    return { action: "none", productName: null, quantity: null, counterUnitPriceRupees: null, contactEmail: null };
  }
}

/** Resolves which existing cart line a set_quantity/remove_from_cart/counter_offer intent refers to: by name if given, or the cart's only line if there's exactly one and no name was given. Never guesses among multiple lines. */
function resolveCartLineTarget(intent: ChatIntent, cart: { lines: CartLineView[] }, catalogue: ChatProduct[]): CartLineView | null {
  if (intent.productName) {
    const resolved = resolveProductByName(catalogue, intent.productName);
    if (!resolved) return null;
    return cart.lines.find((l) => l.variantId === resolved.id) ?? null;
  }
  return cart.lines.length === 1 ? cart.lines[0] : null;
}

/**
 * Layer 11-5: distinct from "couldn't resolve at all" — a customer
 * whose typo doesn't match anything real gets told that plainly, never
 * offered a restock alert for a product that doesn't exist. Only a
 * genuinely resolved, genuinely zero-stock variant reaches this state.
 */
export type AddToCartOutcome = { kind: "added" } | { kind: "unresolvable" } | { kind: "out_of_stock"; variant: ChatProduct };

/** Applies a classified intent to the cart, resolving productName against the real catalogue. The model's proposal is advisory only — every field here is re-validated before being written. Layer 9-close-out: a real multi-line cart via cart.ts, not a single overwritten slot. */
async function applyIntent(
  conversation: typeof schema.conversations.$inferSelect,
  intent: ChatIntent,
  catalogue: ChatProduct[],
  cartBeforeIntent: { lines: CartLineView[] },
): Promise<AddToCartOutcome | null> {
  if (intent.action === "remove_from_cart") {
    const target = resolveCartLineTarget(intent, cartBeforeIntent, catalogue);
    if (target) await removeCartItem(conversation.id, target.variantId);
    return null;
  }

  if (intent.action === "set_quantity") {
    const target = resolveCartLineTarget(intent, cartBeforeIntent, catalogue);
    if (!target) return null; // couldn't tell which line — leave the cart unchanged, the reply explains it wasn't found
    const quantity = intent.quantity && intent.quantity > 0 ? intent.quantity : 1;
    await setCartItemQuantity(conversation.id, target.variantId, quantity);
    return null;
  }

  if (intent.action === "add_to_cart" && intent.productName) {
    const variant = resolveProductByName(catalogue, intent.productName);
    if (!variant) return { kind: "unresolvable" };
    if (variant.stock <= 0) return { kind: "out_of_stock", variant };
    const quantity = intent.quantity && intent.quantity > 0 ? intent.quantity : 1;
    await addCartItem(conversation.id, variant.id, quantity);
    return { kind: "added" };
  }

  // Deterministic safety net, independent of the model's own
  // classification: even when the model reads a real, named product as
  // out of stock in the catalogue text and (despite the prompt asking
  // it not to) classifies the turn as "none" rather than "add_to_cart",
  // a genuinely resolvable, genuinely zero-stock product still gets the
  // restock offer. Whether an item is out of stock is variant.stock <=
  // 0, checked here regardless of what action the model chose — never
  // left to depend on the model reliably following an instruction.
  if (intent.action === "none" && intent.productName) {
    const variant = resolveProductByName(catalogue, intent.productName);
    if (variant && variant.stock <= 0) return { kind: "out_of_stock", variant };
  }

  // counter_offer/provide_contact never touch the cart — handled
  // entirely outside this function, driven separately in handleChatTurn.
  return null;
}

/**
 * Handles one chat turn: classifies intent, applies it deterministically,
 * then asks the model for a natural-language reply grounded in the real
 * catalogue and the (already-updated, code-computed) cart. The model is
 * handed the cart as a fact string it may reference, never asked to
 * compute or restate a total on its own.
 */
/** cart.ts's getCart only knows the plain product name; the catalogue here also has each variant's distinguishing attributes (describeVariant), so a multi-variant product's cart line reads "Ethiopia Yirgacheffe (250g)" instead of just "Ethiopia Yirgacheffe". */
function toChatTurnCart(raw: { lines: CartLineView[]; subtotalPaise: number }, catalogue: ChatProduct[]): ChatTurnResult["cart"] {
  const catalogueById = new Map(catalogue.map((p) => [p.id, p]));
  return {
    subtotalPaise: raw.subtotalPaise,
    lines: raw.lines.map((l) => ({
      variantId: l.variantId,
      productId: l.productId,
      name: catalogueById.get(l.variantId)?.name ?? l.name,
      sku: l.sku,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      subtotalPaise: l.unitPricePaise * l.quantity,
    })),
  };
}

export async function handleChatTurn(
  merchantId: string,
  sessionToken: string,
  customerMessage: string,
): Promise<ChatTurnResult> {
  const conversation = await getOrCreateConversation(merchantId, sessionToken);
  const catalogue = toChatProducts(await getPublicCatalogue(merchantId));

  await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "customer", content: customerMessage });

  // Layer 16-4: a buyer message is untrusted input by definition —
  // scanned deterministically before it ever reaches classifyIntent's
  // model call. A blocked message is refused here, plainly, and never
  // becomes a prompt; this is the deterministic-first, fail-closed-on-
  // untrusted-input path model-armor.ts documents.
  const inboundVerdict = await inspectInbound(customerMessage, {
    merchantId,
    trustLevel: "untrusted",
    auditContext: { conversationId: conversation.id },
  });
  if (!inboundVerdict.clean) {
    const reply = "I can't help with that request. If you meant to ask about a product or your order, try rephrasing.";
    await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
    const rawCart = await getCart(conversation.id);
    return { reply, cart: toChatTurnCart(rawCart, catalogue), offer: null, negotiation: null, restockOffer: null };
  }

  const cartBeforeIntent = await getCart(conversation.id);
  const awaitingRestockEmail = conversation.pendingRestockVariantId !== null;
  const intent = await classifyIntent(customerMessage, catalogue, cartBeforeIntent, awaitingRestockEmail);

  // Layer 11-5: a reply to a pending restock offer, handled before the
  // generic cart-intent path — a customer answering "yes, tell me" or
  // pasting their email is not a cart action, and applyIntent must
  // never see it as one.
  if (awaitingRestockEmail && intent.action === "provide_contact" && intent.contactEmail) {
    const normalized = normalizeEmail(intent.contactEmail);
    const pendingVariant = catalogue.find((p) => p.id === conversation.pendingRestockVariantId);

    await db.update(schema.conversations).set({ pendingRestockVariantId: null }).where(eq(schema.conversations.id, conversation.id));

    if (!normalized || !pendingVariant) {
      const reply = normalized
        ? "Sorry — I lost track of which item that was for. Could you ask about it again?"
        : "That doesn't look like a valid email address — could you double check it?";
      await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
      const rawCart = await getCart(conversation.id);
      return { reply, cart: toChatTurnCart(rawCart, catalogue), offer: null, negotiation: null, restockOffer: null };
    }

    await requestRestockAlert(merchantId, pendingVariant.id, normalized);
    const reply = `Got it — I'll email ${normalized} the moment ${pendingVariant.name} is back in stock.`;
    await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
    const rawCart = await getCart(conversation.id);
    return {
      reply,
      cart: toChatTurnCart(rawCart, catalogue),
      offer: null,
      negotiation: null,
      restockOffer: { state: "recorded", variantName: pendingVariant.name },
    };
  }

  const addOutcome = await applyIntent(conversation, intent, catalogue, cartBeforeIntent);

  // A genuinely resolved, genuinely out-of-stock item — deterministically
  // offer a restock alert (the offer's WORDING can be templated, but
  // whether to offer it at all is variant.stock <= 0, never a model's
  // call). Record the offer as real conversation state so the next
  // turn can recognise a reply to it, and short-circuit the rest of
  // this turn — there is no cart change and nothing else to say.
  if (addOutcome?.kind === "out_of_stock") {
    await db
      .update(schema.conversations)
      .set({ pendingRestockVariantId: addOutcome.variant.id })
      .where(eq(schema.conversations.id, conversation.id));

    const reply = `${addOutcome.variant.name} is out of stock right now. Want me to email you the moment it's back?`;
    await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
    const rawCart = await getCart(conversation.id);
    return {
      reply,
      cart: toChatTurnCart(rawCart, catalogue),
      offer: null,
      negotiation: null,
      restockOffer: { state: "offered", variantName: addOutcome.variant.name },
    };
  }

  // Any other outcome (added, unresolvable, or a non-cart intent) clears
  // a stale pending offer — the customer has moved on to something else.
  if (awaitingRestockEmail) {
    await db.update(schema.conversations).set({ pendingRestockVariantId: null }).where(eq(schema.conversations.id, conversation.id));
  }

  const rawCart = await getCart(conversation.id);
  const cart = toChatTurnCart(rawCart, catalogue);

  // Layer 8: a counter_offer intent is handled entirely outside the
  // generic reply-generation call below — negotiation.ts's
  // submitBuyerCounter is the sole author of what's said about a price,
  // exactly like the SYSTEM FACT discipline this file already applies to
  // the cart (FAILURES.md's Layer 5-7 paraphrasing bug is the reason: a
  // number this important must never pass through a second model call
  // that could restate it differently). rupeesToPaise here is the same
  // form-boundary conversion money.ts uses everywhere else — the model
  // only ever supplies a rupee figure in natural language, never paise.
  // With a multi-item cart, a counter_offer targets whichever specific
  // line the classifier resolved productName against — negotiation
  // stays per-variant (see negotiation.ts), never "the whole cart."
  if (intent.action === "counter_offer" && intent.counterUnitPriceRupees) {
    const target = resolveCartLineTarget(intent, rawCart, catalogue);
    if (!target) {
      const reply = "Sorry — I couldn't tell which item in your cart you're proposing a price for. Could you name it?";
      await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
      return { reply, cart, offer: null, negotiation: null, restockOffer: null };
    }

    const counterUnitPricePaise = rupeesToPaise(intent.counterUnitPriceRupees);

    let negotiationRow = await getOpenNegotiationForIdentity(merchantId, target.variantId, { sessionToken });
    if (!negotiationRow) {
      const opened = await openNegotiation(merchantId, target.variantId, target.quantity, { sessionToken });
      if (!opened.negotiation) {
        const reply = `Sorry — ${opened.refusalReason}`;
        await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });
        return { reply, cart, offer: null, negotiation: null, restockOffer: null };
      }
      negotiationRow = opened.negotiation;
    }

    const result = await submitBuyerCounter(negotiationRow.id, merchantId, { sessionToken }, counterUnitPricePaise);
    await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: result.message });

    return {
      reply: result.message,
      cart,
      offer: null,
      negotiation: {
        negotiationId: result.negotiation.id,
        status: result.negotiation.status,
        catalogueUnitPricePaise: result.negotiation.catalogueUnitPricePaise,
        agreedUnitPricePaise: result.negotiation.agreedUnitPricePaise,
        buyerTurnsUsed: result.negotiation.buyerTurnCount,
        buyerTurnsAllowed: MAX_BUYER_COUNTERS,
      },
      restockOffer: null,
    };
  }

  const history = await getHistory(conversation.id);
  const historyText = history.map((m) => `${m.role === "customer" ? "Customer" : "Assistant"}: ${m.content}`).join("\n");
  const catalogueList = catalogue.map((p) => `- ${p.name}: ${formatPaise(p.pricePaise)} — ${p.description} (${p.stock > 0 ? `${p.stock} in stock` : "out of stock"})`).join("\n");
  const cartFact =
    cart.lines.length > 0
      ? `SYSTEM FACT — the customer's cart currently holds EXACTLY: ${cart.lines.map((l) => `${l.quantity} x "${l.name}"`).join(", ")}. Cart subtotal: ${formatPaise(cart.subtotalPaise)}. These numbers are authoritative and final. If you mention the cart, you must state exactly these quantities and this subtotal — never different ones, even if the conversation earlier suggested otherwise.`
      : "SYSTEM FACT — the customer's cart is currently empty.";

  let reply: string;
  try {
    const { text } = await complete({
      systemPrompt: `You are a friendly storefront assistant for a coffee shop. You may only discuss products in this real catalogue — never invent a product or state a price other than what's given to you:\n${catalogueList}\n\nBe concise, warm, and helpful. If asked about a product not in the catalogue, say plainly that it isn't carried. Never state a total, price, or cart quantity other than one explicitly given to you as a SYSTEM FACT.\n\n${cartFact}`,
      prompt: `Conversation so far:\n${historyText}\n\nRespond to the customer's latest message. If you reference the cart, its contents must match the SYSTEM FACT exactly.`,
    });
    reply = text.trim();
  } catch (err) {
    console.warn("[chat] reply generation failed:", err);
    reply = "Sorry, I'm having trouble responding right now — please try again in a moment.";
  }

  await db.insert(schema.chatMessages).values({ conversationId: conversation.id, role: "assistant", content: reply });

  // Layer 6-3: run the offer engine at most once per cart — an existing
  // open offer for this session is reused, never re-offered or replaced
  // by a second engine run, so a buyer is never shown two upsells for
  // one checkout (getOpenOfferForIdentity is the single source of truth
  // every surface, not just chat, checks first). The engine itself is
  // still keyed to one variant (its own upsell logic reasons about a
  // single item's complements) — Layer 9-close-out runs it against the
  // most recently added line, not the whole cart.
  let offer: ChatTurnResult["offer"] = null;
  if (cart.lines.length > 0) {
    const anchorVariantIdForOffer = cart.lines[cart.lines.length - 1].variantId;
    const existingOffer = await getOpenOfferForIdentity(merchantId, { sessionToken });
    if (existingOffer) {
      const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, existingOffer.bundleId));
      if (bundle) offer = { offerId: existingOffer.id, bundleName: bundle.name, amountPaise: bundle.bundlePricePaise, reasonText: existingOffer.reasonText };
    } else {
      const engineResult = await runOfferEngine(merchantId, anchorVariantIdForOffer, { sessionToken });
      if (engineResult.offer) {
        offer = {
          offerId: engineResult.offer.offerId,
          bundleName: engineResult.offer.bundleName,
          amountPaise: engineResult.offer.amountPaise,
          reasonText: engineResult.offer.reasonText,
        };
      }
    }
  }

  // Surfaces an already-open (or already-agreed) negotiation even on a
  // turn that wasn't itself a counter_offer, so the client can keep
  // showing the merchant's last counter / the agreed-price checkout
  // button across ordinary conversation turns. Checks the most recently
  // added line, same anchor as the offer engine above.
  let negotiation: ChatTurnResult["negotiation"] = null;
  if (cart.lines.length > 0) {
    const anchorVariantId = cart.lines[cart.lines.length - 1].variantId;
    const existingNegotiation = await getOpenNegotiationForIdentity(merchantId, anchorVariantId, { sessionToken });
    if (existingNegotiation) {
      negotiation = {
        negotiationId: existingNegotiation.id,
        status: existingNegotiation.status,
        catalogueUnitPricePaise: existingNegotiation.catalogueUnitPricePaise,
        agreedUnitPricePaise: existingNegotiation.agreedUnitPricePaise,
        buyerTurnsUsed: existingNegotiation.buyerTurnCount,
        buyerTurnsAllowed: MAX_BUYER_COUNTERS,
      };
    }
  }

  return { reply, cart, offer, negotiation, restockOffer: null };
}

export async function getConversationState(merchantId: string, sessionToken: string): Promise<{
  messages: { role: "customer" | "assistant"; content: string }[];
  cart: ChatTurnResult["cart"];
  offer: ChatTurnResult["offer"];
  negotiation: ChatTurnResult["negotiation"];
}> {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.merchantId, merchantId), eq(schema.conversations.sessionToken, sessionToken)));

  if (!conversation) return { messages: [], cart: { lines: [], subtotalPaise: 0 }, offer: null, negotiation: null };

  const catalogue = toChatProducts(await getPublicCatalogue(merchantId));
  const [messages, rawCart] = await Promise.all([getHistory(conversation.id), getCart(conversation.id)]);
  const cart = toChatTurnCart(rawCart, catalogue);

  let offer: ChatTurnResult["offer"] = null;
  const existingOffer = await getOpenOfferForIdentity(merchantId, { sessionToken });
  if (existingOffer) {
    const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, existingOffer.bundleId));
    if (bundle) offer = { offerId: existingOffer.id, bundleName: bundle.name, amountPaise: bundle.bundlePricePaise, reasonText: existingOffer.reasonText };
  }

  let negotiation: ChatTurnResult["negotiation"] = null;
  if (cart.lines.length > 0) {
    const anchorVariantId = cart.lines[cart.lines.length - 1].variantId;
    const existingNegotiation = await getOpenNegotiationForIdentity(merchantId, anchorVariantId, { sessionToken });
    if (existingNegotiation) {
      negotiation = {
        negotiationId: existingNegotiation.id,
        status: existingNegotiation.status,
        catalogueUnitPricePaise: existingNegotiation.catalogueUnitPricePaise,
        agreedUnitPricePaise: existingNegotiation.agreedUnitPricePaise,
        buyerTurnsUsed: existingNegotiation.buyerTurnCount,
        buyerTurnsAllowed: MAX_BUYER_COUNTERS,
      };
    }
  }

  return { messages: messages.map((m) => ({ role: m.role, content: m.content })), cart, offer, negotiation };
}
