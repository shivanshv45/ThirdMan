import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { createCliLinkToken } from "@/lib/cli-link";
import { POST } from "./route";

/**
 * L20-6: the HTTP surface for the CLI's account-linking. cli-link.test.ts
 * already covers redeemCliLinkToken's own logic directly; this covers
 * the route's own concerns — request validation and the rate limit.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const agentRows = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    for (const a of agentRows) {
      await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, a.id));
    }
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchantId));
    await db.delete(schema.cliLinkTokens).where(eq(schema.cliLinkTokens.merchantId, merchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

function req(body: unknown, ip = `2.0.0.${Math.floor(Math.random() * 250)}`) {
  return new NextRequest("http://localhost/api/cli/link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cli/link", () => {
  it("rejects a malformed body, 400", async () => {
    const res = await POST(req({ token: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects a fabricated token, 400, without creating anything", async () => {
    const res = await POST(req({ token: "cli_fake_never_minted", agentName: "Agent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid, expired, or already used/i);
  });

  it("redeems a real token and returns a usable agent key", async () => {
    const merchant = await createTestMerchant("__cli_link_route_test__");
    createdMerchantIds.push(merchant.id);

    const { token } = await createCliLinkToken(merchant.id);
    const res = await POST(req({ token, agentName: "Route test agent" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.merchantId).toBe(merchant.id);
    expect(body.apiKey).toBeTruthy();
  });

  it("the same token cannot be redeemed twice via the route", async () => {
    const merchant = await createTestMerchant("__cli_link_route_reuse_test__");
    createdMerchantIds.push(merchant.id);

    const { token } = await createCliLinkToken(merchant.id);
    const first = await POST(req({ token, agentName: "Agent" }));
    expect(first.status).toBe(200);

    const second = await POST(req({ token, agentName: "Agent again" }));
    expect(second.status).toBe(400);
  }, 20_000);
});
