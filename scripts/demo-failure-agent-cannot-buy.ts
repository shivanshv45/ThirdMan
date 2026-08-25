import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db, schema } from "@/lib/db";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { POST } from "@/app/api/mcp/route";

/**
 * L5-8's required failure demo: an agent discovers a product entirely
 * through this product's own MCP server (Layer 5-4) — the same real tool
 * surface a genuine external client uses — tries to buy more than is in
 * stock, is refused with a reason it can act on, then successfully buys
 * the smaller quantity that's actually available. Bounded autonomy
 * end-to-end on the machine surface: the agent doesn't just get denied
 * and stop, it reads why and recovers.
 *
 * Calls the real /api/mcp route handler directly with a constructed
 * NextRequest — the same pattern src/app/api/mcp/route.test.ts uses, and
 * the same code path a genuine MCP client's HTTP request runs through
 * (auth, rate limiting, the transport, the real gate). L5-4's other
 * required proof — a real external MCP client completing a purchase over
 * the wire — was already demonstrated manually via curl; see PROGRESS.md.
 *
 * Repeatable, self-cleaning (try/finally), explicit exit code on both
 * paths (FAILURES.md — a missing exit reads as a hang).
 */

function mcpRequest(body: object, rawKey: string) {
  return new NextRequest("http://localhost/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rawKey}` },
    body: JSON.stringify(body),
  });
}

async function callTool(rawKey: string, name: string, args: Record<string, unknown>) {
  const res = await POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, rawKey));
  const body = await res.json();
  const text = body.result?.content?.[0]?.text;
  if (!text) throw new Error(`Tool call "${name}" returned no result: ${JSON.stringify(body)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main() {
  console.log("=== Demo: an agent discovers a product via MCP, is refused, then recovers ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [product] = await db
    .insert(schema.products)
    .values({
      merchantId: merchant.id,
      name: "Demo Product — Agent Cannot Buy Scenario",
      description: "Limited stock, for the MCP failure-and-recovery demo.",
      status: "active",
    })
    .returning();

  const sku = `demo-cannot-buy-${Date.now()}`;
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: merchant.id,
      sku,
      pricePaise: 40_000,
      costPaise: 15_000,
      stock: 2,
      status: "active",
    })
    .returning();

  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent — Agent Cannot Buy Scenario", apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();

  try {
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

    console.log("1. Agent discovers the catalogue via list_products (MCP)...");
    const listResult = (await callTool(rawKey, "list_products", { pageSize: 50 })) as {
      products: { name: string; variants: { sku: string; stock: number }[] }[];
    };
    const discovered = listResult.products.find((p) => p.name === product.name);
    if (!discovered) throw new Error("Demo product not found via list_products — MCP catalogue read is broken");
    console.log(`   Found "${discovered.name}", ${discovered.variants[0].stock} in stock.\n`);

    console.log("2. Agent tries to buy 5 units (only 2 in stock) via purchase (MCP)...");
    const overResult = await callTool(rawKey, "purchase", { sku, quantity: 5 });
    console.log(`   ${(overResult.decision as string).toUpperCase()} — ${overResult.reason}\n`);
    if (overResult.decision !== "deny") {
      throw new Error(`Expected the over-quantity purchase to be denied, got ${overResult.decision} — demo scenario is broken`);
    }

    console.log("3. Agent reads the refusal, adjusts, and buys the 2 units that are actually available...");
    const okResult = await callTool(rawKey, "purchase", { sku, quantity: 2 });
    console.log(`   ${(okResult.decision as string).toUpperCase()} — ${okResult.reason}\n`);
    if (okResult.decision !== "allow" && okResult.decision !== "escalate") {
      // "allow" or "escalate" both mean the stock reservation succeeded —
      // the risk layer's model call is genuinely non-deterministic (see
      // PROGRESS.md's note on gate.escalation.test.ts), same caveat
      // already documented for the other concurrency demos.
      throw new Error(`Expected the corrected purchase to succeed (allow or escalate), got ${okResult.decision} — demo scenario is broken`);
    }

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    console.log(`Stock after: ${updatedVariant.stock} (started at 2, the corrected purchase of 2 succeeded).`);

    console.log(
      "\nBounded autonomy end to end on the machine surface: the agent discovered, was refused for a reason it could act on, and recovered — all through the real MCP tool layer, the real gate, and the real spend cap.",
    );
  } finally {
    const moneyActionIds = (
      await db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id))
    ).map((a) => a.id);
    if (moneyActionIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, moneyActionIds));
      await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, moneyActionIds));
    }
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    await db.delete(schema.products).where(eq(schema.products.id, product.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
