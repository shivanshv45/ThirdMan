import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { setMerchantAgentTerms } from "@/lib/agent-terms";
import { authenticateAgent } from "@/lib/agent-auth";
import { POST } from "./route";

/**
 * L21-8: the HTTP surface for self-serve registration. registerAgent's
 * own unit tests (agent-terms.test.ts) cover the closed-by-default and
 * cap-composition behaviour directly; this covers the route's own
 * concerns — request validation, the 404 on a fabricated merchant, and
 * the per-IP rate limit.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const agentRows = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    for (const a of agentRows) {
      await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, a.id));
      await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, a.id));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchantAgentTerms).where(eq(schema.merchantAgentTerms.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

function req(body: unknown, ip = `1.0.0.${Math.floor(Math.random() * 250)}`) {
  return new NextRequest("http://localhost/api/agent/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/register", () => {
  it("rejects a malformed body, 400", async () => {
    const res = await POST(req({ merchantId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("404s for a merchant that doesn't exist", async () => {
    const res = await POST(req({ merchantId: "00000000-0000-0000-0000-000000000000", name: "ghost" }));
    expect(res.status).toBe(404);
  });

  it("returns registered: false (200), not an error, when the merchant hasn't opened registration", async () => {
    const merchant = await createTestMerchant("__register_route_closed__");
    createdMerchantIds.push(merchant.id);

    const res = await POST(req({ merchantId: merchant.id, name: "a stranger's agent" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(false);
  }, 20_000);

  it("issues a real, authenticating key when the merchant has opened registration", async () => {
    const merchant = await createTestMerchant("__register_route_open__");
    createdMerchantIds.push(merchant.id);
    await setMerchantAgentTerms({
      merchantId: merchant.id,
      unknownAgentsAllowed: true,
      newAgentOrderCeilingPaise: null,
      mandateRequiredAbovePaise: null,
      negotiationOpenToAgents: false,
      selfRegisterDefaultCapabilities: ["products:read"],
      selfRegistrationOpen: true,
      selfRegisterStartingCapPaise: 10_000,
      selfRegisterPerTransactionMaxPaise: 5_000,
    });

    const res = await POST(req({ merchantId: merchant.id, name: "a real stranger's agent" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(true);
    expect(typeof body.apiKey).toBe("string");

    const authed = await authenticateAgent(body.apiKey);
    expect(authed?.id).toBe(body.agentId);
    expect(authed?.merchantId).toBe(merchant.id);
  }, 20_000);

  it("rate-limits repeated requests from the same IP", async () => {
    const merchant = await createTestMerchant("__register_route_ratelimit__");
    createdMerchantIds.push(merchant.id);
    const ip = "198.51.100.42";

    const results = await Promise.all(Array.from({ length: 10 }, () => POST(req({ merchantId: merchant.id, name: "spammy agent" }, ip))));
    expect(results.some((r) => r.status === 429)).toBe(true);
  });
});
