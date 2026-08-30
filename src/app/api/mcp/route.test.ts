import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { POST } from "./route";

/**
 * L5-4/L5-8: this product's own MCP server. Calls the real route handler
 * directly with a constructed NextRequest (same pattern as
 * agent/purchase/route.test.ts) — no server process needed, and no mock
 * of the gate or the DB. What matters most: purchase goes through the
 * real gate (money_actions row + audit entry, same as any other agent
 * purchase), every tool is merchant-scoped by id enumeration (not empty
 * list — isolation.test.ts's standard), and costPaise never appears in
 * any tool's output.
 */

function mcpRequest(body: object, rawKey: string | null) {
  return new NextRequest("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(rawKey ? { authorization: `Bearer ${rawKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function callTool(rawKey: string, name: string, args: Record<string, unknown> = {}) {
  const res = await POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, rawKey));
  const body = await res.json();
  const text = body.result?.content?.[0]?.text;
  return { httpStatus: res.status, jsonRpc: body, toolResult: text ? JSON.parse(text) : undefined };
}

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__mcp_route_test_${Date.now()}_${Math.random()}__`,
      email: `mcp_route_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgentWithCap(merchantId: string) {
  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__mcp_route_test_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();

  const now = new Date();
  await db.insert(schema.spendCaps).values({
    agentId: agent.id,
    capPaise: 10_000_000,
    spentPaise: 0,
    perTransactionMaxPaise: 10_000_000,
    windowStart: now,
    windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    status: "active",
  });

  // Layer 13-2: this shared helper backs tests across nearly every MCP
  // tool (list_products, purchase, negotiate, get_merchant_policy, ...),
  // each gated by its own capability — grant the full set, the same
  // backfill every pre-Layer-13 agent got at migration time.
  await db.insert(schema.agentCapabilities).values(schema.agentCapabilityEnum.enumValues.map((capability) => ({ agentId: agent.id, capability })));

  return { agent, rawKey };
}

async function makeProductWithVariant(merchantId: string, sku: string) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__mcp test product__", description: "test", status: "active" })
    .returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product.id, merchantId, sku, pricePaise: 60_000, costPaise: 25_000, stock: 10, status: "active" })
    .returning();
  return { product, variant };
}

describe("POST /api/mcp", () => {
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

    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));

    // Layer 8: negotiations/negotiation_turns FK into agents and
    // product_variants — must go before both, and negotiation_turns
    // before negotiations. Same FK-dependency-order discipline
    // FAILURES.md documents elsewhere (L1-2/L3-6/L6-1).
    const negotiationIds = (
      await db.select({ id: schema.negotiations.id }).from(schema.negotiations).where(eq(schema.negotiations.merchantId, currentMerchantId))
    ).map((n) => n.id);
    if (negotiationIds.length > 0) {
      await db.delete(schema.negotiationTurns).where(inArray(schema.negotiationTurns.negotiationId, negotiationIds));
    }
    await db.delete(schema.negotiations).where(eq(schema.negotiations.merchantId, currentMerchantId));

    if (currentAgentIds.length > 0) {
      await db.delete(schema.agentCapabilities).where(inArray(schema.agentCapabilities.agentId, currentAgentIds));
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("rejects a request with no Authorization header, 401", async () => {
    const res = await POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, null));
    expect(res.status).toBe(401);
  });

  it("completes the MCP initialize handshake for an authenticated agent", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const res = await POST(
      mcpRequest(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
        rawKey,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("razorpay-agentic-commerce");
  });

  it("list_products returns only this agent's own merchant's catalogue, never costPaise", async () => {
    const merchantA = await makeMerchant();
    merchantId = merchantA.id;
    const { agent, rawKey } = await makeAgentWithCap(merchantA.id);
    agentIds.push(agent.id);
    const { product } = await makeProductWithVariant(merchantA.id, `MCP-LIST-${Date.now()}`);
    productIds.push(product.id);

    const merchantB = await makeMerchant();
    const { product: productOfB } = await makeProductWithVariant(merchantB.id, `MCP-OTHER-${Date.now()}`);

    try {
      const { toolResult } = await callTool(rawKey, "list_products", { pageSize: 50 });
      const productIdsReturned = toolResult.products.map((p: { id: string }) => p.id);
      expect(productIdsReturned).toContain(product.id);
      expect(productIdsReturned).not.toContain(productOfB.id);

      const raw = JSON.stringify(toolResult);
      expect(raw).not.toMatch(/costPaise/i);
    } finally {
      await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, productOfB.id));
      await db.delete(schema.products).where(eq(schema.products.id, productOfB.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    }
  }, 20_000);

  it("get_product for another merchant's real product id is refused, not leaked, by id enumeration", async () => {
    const merchantA = await makeMerchant();
    merchantId = merchantA.id;
    const { agent, rawKey } = await makeAgentWithCap(merchantA.id);
    agentIds.push(agent.id);

    const merchantB = await makeMerchant();
    const { product: productOfB } = await makeProductWithVariant(merchantB.id, `MCP-ENUM-${Date.now()}`);

    try {
      const { toolResult } = await callTool(rawKey, "get_product", { productId: productOfB.id });
      expect(toolResult.found).toBe(false);
    } finally {
      await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, productOfB.id));
      await db.delete(schema.products).where(eq(schema.products.id, productOfB.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    }
  });

  it("purchase over MCP goes through the real gate: a money_actions row and audit entry exist", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);
    const sku = `MCP-BUY-${Date.now()}`;
    const { product, variant } = await makeProductWithVariant(merchant.id, sku);
    productIds.push(product.id);

    const { toolResult } = await callTool(rawKey, "purchase", { sku, quantity: 1 });
    expect(toolResult.decision).toBe("allow");
    expect(toolResult.moneyActionId).toBeDefined();

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, toolResult.moneyActionId));
    expect(action.variantId).toBe(variant.id);
    expect(action.amountPaise).toBe(variant.pricePaise);

    const [auditEntry] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.moneyActionId, toolResult.moneyActionId));
    expect(auditEntry).toBeDefined();
    expect(auditEntry.decision).toBe("allow");
  }, 20_000);

  it("a purchase exceeding the spend cap is refused with a readable reason, not a protocol error", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const rawKey = generateApiKey();
    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__mcp_tiny_cap_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
      .returning();
    agentIds.push(agent.id);
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "purchase:create" });
    const now = new Date();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100, // far below any real product's price
      spentPaise: 0,
      perTransactionMaxPaise: 100,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    });

    const sku = `MCP-OVERCAP-${Date.now()}`;
    const { product } = await makeProductWithVariant(merchant.id, sku);
    productIds.push(product.id);

    const { toolResult } = await callTool(rawKey, "purchase", { sku, quantity: 1 });
    expect(toolResult.decision).toBe("deny");
    expect(toolResult.reason).toMatch(/exceeds/i);
  }, 20_000);

  it("purchase by an unknown SKU is a clean denial, not an error", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const { toolResult } = await callTool(rawKey, "purchase", { sku: "DOES-NOT-EXIST" });
    expect(toolResult.decision).toBe("deny");
    expect(toolResult.reason).toMatch(/no sku/i);
  });

  it("get_spend_status returns the calling agent's own cap, not another agent's", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const { toolResult } = await callTool(rawKey, "get_spend_status");
    expect(toolResult.spendCap.capPaise).toBe(10_000_000);
    expect(toolResult.agentStatus).toBe("active");
  });

  it("get_merchant_policy reports unpublished honestly when no policy was ever set", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);

    const { toolResult } = await callTool(rawKey, "get_merchant_policy");
    expect(toolResult.published).toBe(false);
    expect(toolResult.summary).toMatch(/not published/i);
  });

  it("negotiate opens a negotiation only on a variant with a floor set — no floor means refused, not opened", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);
    const { product, variant } = await makeProductWithVariant(merchant.id, `MCP-NEG-NOFLOOR-${Date.now()}`);
    productIds.push(product.id);

    const { toolResult } = await callTool(rawKey, "negotiate", { sku: variant.sku });
    expect(toolResult.outcome).toBe("refused");
    expect(toolResult.message).toMatch(/not negotiable/i);
  });

  it("negotiate over MCP: a real floor holds even under a lowball counter, and an agreed price redeems as a real purchase", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const { agent, rawKey } = await makeAgentWithCap(merchant.id);
    agentIds.push(agent.id);
    const { product, variant } = await makeProductWithVariant(merchant.id, `MCP-NEG-FLOOR-${Date.now()}`);
    productIds.push(product.id);
    await db.update(schema.productVariants).set({ floorPricePaise: 50_000 }).where(eq(schema.productVariants.id, variant.id));

    const opened = await callTool(rawKey, "negotiate", { sku: variant.sku });
    expect(opened.toolResult.outcome).toBe("opened");
    const negotiationId = opened.toolResult.negotiationId;

    // At exactly the floor, agreed immediately — deterministic, no model
    // decision required for the accept path.
    const countered = await callTool(rawKey, "negotiate", { negotiationId, offerUnitPricePaise: 50_000 });
    expect(countered.toolResult.outcome).toBe("agreed");
    expect(countered.toolResult.agreedUnitPricePaise).toBe(50_000);

    const purchase = await callTool(rawKey, "purchase", { negotiationId });
    expect(purchase.toolResult.decision).toBe("allow");

    const [moneyAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.negotiationId, negotiationId));
    expect(moneyAction).toBeDefined();
    expect(moneyAction.amountPaise).toBe(50_000);
  }, 30_000);

  it("negotiate is agent-scoped by enumeration — agent B cannot continue agent A's negotiation with its real id", async () => {
    const merchantA = await makeMerchant();
    merchantId = merchantA.id;
    const { agent: agentA, rawKey: rawKeyA } = await makeAgentWithCap(merchantA.id);
    agentIds.push(agentA.id);
    const { agent: agentB, rawKey: rawKeyB } = await makeAgentWithCap(merchantA.id);
    agentIds.push(agentB.id);
    const { product, variant } = await makeProductWithVariant(merchantA.id, `MCP-NEG-ISOLATION-${Date.now()}`);
    productIds.push(product.id);
    await db.update(schema.productVariants).set({ floorPricePaise: 50_000 }).where(eq(schema.productVariants.id, variant.id));

    const opened = await callTool(rawKeyA, "negotiate", { sku: variant.sku });
    const negotiationId = opened.toolResult.negotiationId;

    const crossAgentAttempt = await callTool(rawKeyB, "negotiate", { negotiationId, offerUnitPricePaise: 50_000 });
    expect(crossAgentAttempt.toolResult.outcome).toBe("refused");
  }, 20_000);
});
