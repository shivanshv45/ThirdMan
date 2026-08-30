import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { verifyIntegration } from "./integration-verify";

/**
 * Layer 24-9: "did it actually work" checks. The DB-backed checks
 * (origin allowlist, agent capability, first purchase) run against the
 * real database. The two HTTP checks are exercised against a real
 * local HTTP server standing in for "the app's own routes" — proving
 * the fetch/status-code judgment is correct — matching this codebase's
 * genuine-failures-only testing philosophy (DECISIONS.md); a real,
 * running Next.js dev server is out of scope for a unit test, so
 * verifyIntegration is called with appOrigin pointed at this local
 * server, which serves fixture responses shaped like the real routes.
 */

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("verifyIntegration — real DB + real local HTTP", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;

    const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length > 0) {
      await db.delete(schema.agentCapabilities).where(inArray(schema.agentCapabilities.agentId, agentIds));
    }
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("reports every check as failing honestly for a brand-new merchant with none of this configured", async () => {
    const merchant = await createTestMerchant("__integration_verify_test__");
    merchantId = merchant.id;

    // A server whose manifest route 404s and whose /api/mcp doesn't respond as expected —
    // stands in for a real deployment that hasn't been reached/configured.
    const server = createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    const port = await listenOnEphemeralPort(server);

    try {
      const report = await verifyIntegration(merchant.id, `http://127.0.0.1:${port}`);
      expect(report.checks.find((c) => c.id === "origin_allowlisted")?.passed).toBe(false);
      expect(report.checks.find((c) => c.id === "discovery_document_resolves")?.passed).toBe(false);
      expect(report.checks.find((c) => c.id === "mcp_endpoint_live")?.passed).toBe(false);
      expect(report.checks.find((c) => c.id === "agent_capable_of_authenticating")?.passed).toBe(false);
      expect(report.checks.find((c) => c.id === "first_purchase_gated")?.passed).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("reports each check as passing once its real evidence exists", async () => {
    const merchant = await createTestMerchant("__integration_verify_test_2__");
    merchantId = merchant.id;

    await db.insert(schema.embedConfigs).values({ merchantId: merchant.id, publishableKey: `pk_test_${Date.now()}`, allowedOrigins: ["https://example.com"] });

    const [agent] = await db.insert(schema.agents).values({ merchantId: merchant.id, name: "__iv_agent__", apiKeyHash: `iv_test_${Date.now()}`, status: "active" }).returning();
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "products:read" });

    await db.insert(schema.moneyActions).values({ merchantId: merchant.id, agentId: agent.id, amountPaise: 1000, quantity: 1, type: "order_create", status: "captured" });

    // A server that resolves the manifest 200 and correctly rejects an unauthenticated MCP-shaped POST with 401.
    const server = createServer((req, res) => {
      if (req.url?.includes("/manifest.json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url === "/api/mcp") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"invalid or missing agent API key"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listenOnEphemeralPort(server);

    try {
      const report = await verifyIntegration(merchant.id, `http://127.0.0.1:${port}`);
      expect(report.checks.find((c) => c.id === "origin_allowlisted")?.passed).toBe(true);
      expect(report.checks.find((c) => c.id === "discovery_document_resolves")?.passed).toBe(true);
      expect(report.checks.find((c) => c.id === "mcp_endpoint_live")?.passed).toBe(true);
      expect(report.checks.find((c) => c.id === "agent_capable_of_authenticating")?.passed).toBe(true);
      expect(report.checks.find((c) => c.id === "first_purchase_gated")?.passed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
