import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { getRecentAuditEntries } from "@/lib/audit";
import { createMcpServerForAgent } from "@/lib/mcp-server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Layer 19's required failure demo, distinct from demo-failure-cap-
 * exceeded.ts: there, a script calls attemptMoneyAction() directly,
 * skipping the transport entirely. Here, the call goes over a real MCP
 * client/server pair — the exact protocol surface, tool schema, and
 * response shape the standalone agent-buyer/ package's own MCP client
 * uses against the real /api/mcp route (see mcp-client.ts) — proving
 * the bound holds for a caller shaped like a real autonomous agent's
 * tool call, not just for a script's own direct function call.
 *
 * Deliberately no live Gemini call here (see L19-4/FAILURES.md — the
 * free tier rate-limits and this demo must be reliable enough to run
 * unattended, matching demo-failure-upsell-refused.ts's own reasoning
 * for avoiding a live model call in ITS failure demo). agent-buyer/'s
 * own live runs (scripts/seed-buyer-agent.ts + agent-buyer/src/run.ts)
 * are where the real model's own overspend attempt is demonstrated —
 * this script proves the transport-level bound underneath that
 * unscripted behaviour is real and reliable on its own.
 *
 * Repeatable, self-cleaning (try/finally), explicit exit code on both
 * paths (FAILURES.md — a missing exit reads as a hang).
 */

async function main() {
  console.log("=== Demo: an autonomous buyer's own MCP tool call overspends its cap, and is refused ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent — Buyer Overspends Scenario", apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();

  const [product] = await db
    .insert(schema.products)
    .values({ merchantId: merchant.id, name: "Demo Product — Buyer Overspends Scenario", description: "A real variant a real MCP client tries to overbuy.", status: "active" })
    .returning();
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId: merchant.id,
      sku: `demo-buyer-overspends-${Date.now()}`,
      pricePaise: 90_000, // ₹900/unit
      costPaise: 40_000,
      stock: 40,
      status: "active",
    })
    .returning();

  try {
    const now = new Date();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000, // ₹1000
      spentPaise: 0,
      perTransactionMaxPaise: 100_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    });
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "purchase:create" });

    console.log(`Agent "${agent.name}" authorised with a ₹1000 cap, holding purchase:create.`);
    console.log(`Merchant lists "${variant.sku}" at ₹900/unit.\n`);

    // A real MCP client/server pair over an in-memory transport —
    // genuinely the protocol, not a shortcut, without needing a live
    // HTTP server process (the same allowance route.test.ts's own
    // "call the handler directly" pattern makes for the transport
    // layer one level up).
    const server = createMcpServerForAgent(agent);
    const client = new Client({ name: "demo-overspend-buyer", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    console.log("Buyer agent calls purchase(sku, quantity: 2) — 2 units at ₹900 = ₹1800, over the ₹1000 cap.\n");

    const result = await client.callTool({ name: "purchase", arguments: { sku: variant.sku, quantity: 2 } });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    console.log(`Gate decision: ${parsed.decision.toUpperCase()}`);
    console.log(`Reason: ${parsed.reason}\n`);

    if (parsed.decision !== "deny") {
      throw new Error(`Expected a deny, got ${parsed.decision} — demo scenario is broken`);
    }

    const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    console.log(`Spend cap unchanged: ₹${(cap.spentPaise / 100).toFixed(2)} spent of ₹${(cap.capPaise / 100).toFixed(2)}.\n`);
    if (cap.spentPaise !== 0) {
      throw new Error(`Expected spentPaise to stay 0 after a denial, got ${cap.spentPaise} — demo scenario is broken`);
    }

    const trail = await getRecentAuditEntries(merchant.id, 5);
    const entry = trail.find((e) => e.reason === parsed.reason);
    console.log("Audit trail entry confirming this was logged:");
    console.log(`  [${entry?.decision.toUpperCase()}] ${entry?.reason}`);
    console.log(`  Bound applied: ${entry?.boundApplied}\n`);

    await client.close();
    await server.close();

    console.log("No money moved. The refusal came back over the real MCP protocol, in the shape a real autonomous agent reads and adapts to — this is the same tool call agent-buyer/ makes, not a script's own shortcut.");
  } finally {
    await db
      .delete(schema.auditLog)
      .where(
        inArray(
          schema.auditLog.moneyActionId,
          db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id)),
        ),
      );
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id));
    await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agent.id));
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
