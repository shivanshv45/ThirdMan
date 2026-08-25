import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "@/lib/db";
import { getPublicCatalogue, type PublicProduct } from "@/lib/storefront-catalogue";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";
import { attemptMoneyAction } from "@/lib/gate";
import { formatPaise } from "@/lib/money";
import { runOfferEngine, getOpenOfferForIdentity } from "@/lib/offer-engine";
import { acceptOffer } from "@/lib/discount";
import { getRewardBalance, redeemRewardCoins } from "@/lib/reward-actions";

/**
 * This product's own MCP server (Layer 5-4) — the headline of the layer.
 * Exposes the merchant's catalogue, policy, and a bounded purchase tool
 * to an external buyer agent that has never integrated with this product
 * before. Deliberately not Razorpay's own MCP server, which exposes a
 * merchant's Razorpay account operations to the merchant's own assistant
 * — the opposite direction from what an external buyer needs. See
 * DECISIONS.md.
 *
 * Auth: the same agent API key every /api/agent/* route already accepts
 * as a bearer token (agent-auth.ts) — not OAuth 2.1. See DECISIONS.md for
 * why, and what that gives up.
 *
 * Every tool is scoped to the authenticated agent's own merchantId. purchase
 * routes through attemptMoneyAction() unchanged — no second money path.
 * A denial is a successful tool result describing the refusal, never a
 * protocol-level error, matching the agent API's "a denial is HTTP 200."
 */

type Agent = typeof schema.agents.$inferSelect;

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function findVariantBySku(catalogue: PublicProduct[], sku: string) {
  const needle = sku.trim().toLowerCase();
  for (const product of catalogue) {
    const variant = product.variants.find((v) => v.sku.toLowerCase() === needle);
    if (variant) return { product, variant };
  }
  return null;
}

/** Builds a fresh McpServer instance wired to one authenticated agent's data. A new instance per request keeps every tool call's data scoped to that agent, with no cross-request state to leak. */
export function createMcpServerForAgent(agent: Agent): McpServer {
  const server = new McpServer({ name: "razorpay-agentic-commerce", version: "1.0.0" });

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "Lists this merchant's active catalogue. Each product may have multiple variants (e.g. sizes); each variant has its own id, SKU, price (integer paise, not rupees), and stock. Supports optional filters. Paginated — a large catalogue is never returned as one blob.",
      inputSchema: {
        category: z.string().optional().describe("Filter to products in this category, e.g. 'food_beverage'."),
        availability: z.enum(["in_stock", "out_of_stock", "preorder", "discontinued"]).optional().describe("Filter variants to this availability status."),
        minPricePaise: z.number().int().nonnegative().optional().describe("Minimum variant price in integer paise."),
        maxPricePaise: z.number().int().nonnegative().optional().describe("Maximum variant price in integer paise."),
        page: z.number().int().positive().default(1).describe("1-based page number."),
        pageSize: z.number().int().positive().max(50).default(20).describe("Products per page, max 50."),
      },
    },
    async ({ category, availability, minPricePaise, maxPricePaise, page, pageSize }) => {
      let catalogue = await getPublicCatalogue(agent.merchantId);

      if (category) catalogue = catalogue.filter((p) => p.category === category);

      catalogue = catalogue
        .map((p) => ({
          ...p,
          variants: p.variants.filter((v) => {
            if (availability && v.availability !== availability) return false;
            if (minPricePaise !== undefined && v.pricePaise < minPricePaise) return false;
            if (maxPricePaise !== undefined && v.pricePaise > maxPricePaise) return false;
            return true;
          }),
        }))
        .filter((p) => p.variants.length > 0);

      const start = (page - 1) * pageSize;
      const pageItems = catalogue.slice(start, start + pageSize);

      return toolText(
        JSON.stringify(
          {
            page,
            pageSize,
            totalProducts: catalogue.length,
            products: pageItems,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Fetches one product by its id, with all variants, attributes, and availability. Returns a not-found message (not an error) if the id doesn't belong to this merchant's active catalogue.",
      inputSchema: { productId: z.string().uuid() },
    },
    async ({ productId }) => {
      const catalogue = await getPublicCatalogue(agent.merchantId);
      const product = catalogue.find((p) => p.id === productId);
      if (!product) return toolText(JSON.stringify({ found: false, reason: `No product ${productId} found for this merchant.` }));
      return toolText(JSON.stringify({ found: true, product }, null, 2));
    },
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Deterministic search over the real catalogue's name, description, SKU, and attribute values — a substring/word-overlap match, not an LLM call, so results are fast, reproducible, and free. Use list_products with filters instead if you already know the category or price range.",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => {
      const catalogue = await getPublicCatalogue(agent.merchantId);
      const needle = query.trim().toLowerCase();
      const words = needle.split(/\s+/).filter((w) => w.length > 1);

      const scored = catalogue
        .map((product) => {
          const haystack = [
            product.name,
            product.description,
            product.category,
            product.subcategory ?? "",
            ...product.variants.flatMap((v) => [v.sku, ...Object.values(v.attributes)]),
          ]
            .join(" ")
            .toLowerCase();
          const score = words.filter((w) => haystack.includes(w)).length;
          return { product, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.product);

      return toolText(JSON.stringify({ query, results: scored }, null, 2));
    },
  );

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description: "Given a SKU and a desired quantity, reports whether that many are available right now and, if not, how many are. Cheap — call this before attempting a purchase, not after it fails.",
      inputSchema: { sku: z.string().min(1), quantity: z.number().int().positive().default(1) },
    },
    async ({ sku, quantity }) => {
      const catalogue = await getPublicCatalogue(agent.merchantId);
      const found = findVariantBySku(catalogue, sku);
      if (!found) return toolText(JSON.stringify({ found: false, reason: `No SKU "${sku}" found for this merchant.` }));

      const available = found.variant.availability === "in_stock" && found.variant.stock >= quantity;
      return toolText(
        JSON.stringify(
          {
            found: true,
            sku: found.variant.sku,
            variantId: found.variant.id,
            requestedQuantity: quantity,
            availableStock: found.variant.stock,
            availability: found.variant.availability,
            canFulfill: available,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "get_merchant_policy",
    {
      title: "Get merchant policy",
      description: "Returns this merchant's structured return, refund, and shipping terms. A cautious buyer should check this before committing to a purchase it might need to reverse. If the merchant has never published a policy, this says so plainly rather than assuming a permissive default.",
      inputSchema: {},
    },
    async () => {
      const policy = await getMerchantPolicy(agent.merchantId);
      return toolText(
        JSON.stringify(
          {
            published: policy !== null,
            summary: describeMerchantPolicy(policy),
            structured: policy
              ? {
                  returnsAccepted: policy.returnsAccepted,
                  returnWindowDays: policy.returnWindowDays,
                  refundMethod: policy.refundMethod,
                  restockingFeePercent: policy.restockingFeePercent,
                  shippingRegions: policy.shippingRegions,
                  handlingTimeDays: policy.handlingTimeDays,
                  warrantyMonths: policy.warrantyMonths,
                }
              : null,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "get_spend_status",
    {
      title: "Get spend status",
      description: "Returns YOUR OWN (the calling agent's) remaining spend cap, per-transaction limit, and the current window — check this before attempting a purchase to know what you're allowed to spend, not just find out after being refused.",
      inputSchema: {},
    },
    async () => {
      if (agent.status !== "active") {
        return toolText(JSON.stringify({ agentStatus: agent.status, spendCap: null, note: "This agent is not active and cannot transact." }));
      }

      const [cap] = await db
        .select()
        .from(schema.spendCaps)
        .where(eq(schema.spendCaps.agentId, agent.id))
        .orderBy(desc(schema.spendCaps.createdAt))
        .limit(1);

      if (!cap) return toolText(JSON.stringify({ agentStatus: agent.status, spendCap: null }));

      return toolText(
        JSON.stringify(
          {
            agentStatus: agent.status,
            spendCap: {
              status: cap.status,
              capPaise: cap.capPaise,
              spentPaise: cap.spentPaise,
              remainingPaise: Math.max(cap.capPaise - cap.spentPaise, 0),
              perTransactionMaxPaise: cap.perTransactionMaxPaise,
              windowStart: cap.windowStart,
              windowEnd: cap.windowEnd,
            },
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "get_reward_balance",
    {
      title: "Get reward coin balance",
      description:
        "Returns YOUR OWN reward-coin balance with this merchant, if they run a rewards program (Layer 6-5). enabled: false means this merchant hasn't turned rewards on — balance is always 0 then, not an error. Coins are earned automatically on a captured purchase and can be spent via redeem_reward_coins against a future one.",
      inputSchema: {},
    },
    async () => {
      const balance = await getRewardBalance(agent.merchantId, { agentId: agent.id });
      return toolText(JSON.stringify(balance));
    },
  );

  server.registerTool(
    "redeem_reward_coins",
    {
      title: "Redeem reward coins",
      description:
        "Redeems some of your own reward coins as a real, gated money action, bounded by your actual balance (see get_reward_balance) and the merchant's own maximum redemption percent for a purchase of this size — both re-checked here, you cannot request more than either allows. A denial explains exactly which bound was hit.",
      inputSchema: {
        purchaseAmountPaise: z.number().int().positive().describe("The catalogue price (integer paise) of the purchase you're redeeming against."),
        coins: z.number().int().positive(),
      },
    },
    async ({ purchaseAmountPaise, coins }) => {
      const result = await redeemRewardCoins(agent.merchantId, agent.id, purchaseAmountPaise, coins, { agentId: agent.id });
      return toolText(JSON.stringify(result));
    },
  );

  server.registerTool(
    "get_offers",
    {
      title: "Get offers",
      description:
        "Checks for a margin-aware bundle upsell relevant to a SKU you're about to buy (Layer 6). Deterministically filtered — every candidate is in stock and clears the merchant's own margin floor before a model ever ranks them — so this may genuinely return no offer, which is a normal, expected result, not an error. If it returns one, its id can be passed to purchase's offerId to buy the bundle at the price given here (never a price you compute yourself). At most one open offer exists per agent at a time; calling this again before acting on or discarding the first one returns the same offer.",
      inputSchema: { sku: z.string().min(1) },
    },
    async ({ sku }) => {
      const catalogue = await getPublicCatalogue(agent.merchantId);
      const found = findVariantBySku(catalogue, sku);
      if (!found) return toolText(JSON.stringify({ found: false, reason: `No SKU "${sku}" found for this merchant.` }));

      const existing = await getOpenOfferForIdentity(agent.merchantId, { agentId: agent.id });
      if (existing) {
        const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, existing.bundleId));
        return toolText(
          JSON.stringify({
            offer: bundle ? { offerId: existing.id, bundleName: bundle.name, amountPaise: bundle.bundlePricePaise, reasonText: existing.reasonText } : null,
          }),
        );
      }

      const result = await runOfferEngine(agent.merchantId, found.variant.id, { agentId: agent.id });
      return toolText(
        JSON.stringify({
          offer: result.offer
            ? { offerId: result.offer.offerId, bundleName: result.offer.bundleName, amountPaise: result.offer.amountPaise, reasonText: result.offer.reasonText }
            : null,
          noOfferReason: result.noOfferReason,
        }),
      );
    },
  );

  server.registerTool(
    "purchase",
    {
      title: "Purchase",
      description:
        "Buys a specific variant by its SKU, at the catalogue's real price — you cannot set the price yourself. Quantity defaults to 1. Alternatively, pass offerId (from get_offers) instead of sku/quantity to buy an accepted bundle upsell at ITS real price — also never one you set. Subject to your own spend cap (see get_spend_status); a purchase that would exceed it, or a variant that's out of stock, comes back as a successful tool result describing exactly why it was refused, not a protocol error — read the result to see if you were allowed, denied, or escalated for human review.",
      inputSchema: {
        sku: z.string().min(1).optional(),
        quantity: z.number().int().positive().max(999).default(1),
        offerId: z.string().uuid().optional().describe("Buy a bundle offer from get_offers instead of a single SKU. Mutually exclusive with sku."),
        idempotencyKey: z.string().min(1).max(200).optional().describe("Optional. A repeated call with the same key returns the original outcome instead of buying twice."),
      },
    },
    async ({ sku, quantity, offerId, idempotencyKey }) => {
      if (offerId) {
        const [offer] = await db.select().from(schema.offers).where(eq(schema.offers.id, offerId));
        if (!offer || offer.merchantId !== agent.merchantId) {
          return toolText(JSON.stringify({ decision: "deny", reason: `No offer ${offerId} found for this merchant.` }));
        }
        const [bundle] = await db.select().from(schema.bundles).where(eq(schema.bundles.id, offer.bundleId));
        if (!bundle) return toolText(JSON.stringify({ decision: "deny", reason: `No offer ${offerId} found for this merchant.` }));

        if (offer.status === "offered") {
          await acceptOffer(agent.merchantId, offerId, { agentId: agent.id });
        }

        const result = await attemptMoneyAction({
          agentId: agent.id,
          merchantId: agent.merchantId,
          type: "order_create",
          amountPaise: bundle.bundlePricePaise,
          context: `MCP purchase: bundle "${bundle.name}"`,
          offerId,
        });

        return toolText(JSON.stringify({ ...result, bundleName: bundle.name, amountFormatted: formatPaise(bundle.bundlePricePaise) }, null, 2));
      }

      if (!sku) {
        return toolText(JSON.stringify({ decision: "deny", reason: "Either sku or offerId is required." }));
      }

      const catalogue = await getPublicCatalogue(agent.merchantId);
      const found = findVariantBySku(catalogue, sku);
      if (!found) {
        return toolText(JSON.stringify({ decision: "deny", reason: `No SKU "${sku}" found for this merchant.` }));
      }

      const amountPaise = found.variant.pricePaise * quantity;
      const result = await attemptMoneyAction({
        agentId: agent.id,
        merchantId: agent.merchantId,
        type: "order_create",
        amountPaise,
        context: `MCP purchase: ${found.product.name} (${found.variant.sku})`,
        variantId: found.variant.id,
        quantity,
        idempotencyKey,
      });

      return toolText(
        JSON.stringify(
          {
            ...result,
            sku: found.variant.sku,
            quantity,
            amountFormatted: formatPaise(amountPaise),
          },
          null,
          2,
        ),
      );
    },
  );

  return server;
}
