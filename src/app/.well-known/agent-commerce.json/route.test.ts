import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { GET } from "./route";
import { GET as manifestGET } from "@/app/store/[merchantId]/manifest.json/route";
import { POST as mcpPOST } from "@/app/api/mcp/route";

/**
 * L21-1/L21-5: the conventional discovery location, and the important
 * test that keeps L21-2's honesty rule true over time — everything the
 * manifest advertises must actually be reachable. An advertised MCP
 * endpoint that 404s is exactly the failure this exists to prevent.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

function req(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

describe("GET /.well-known/agent-commerce.json", () => {
  it("resolves and lists only merchants with a connected Razorpay account", async () => {
    const connected = await createTestMerchant("__wellknown_connected__", { withRazorpayCredentials: true });
    const unconnected = await createTestMerchant("__wellknown_unconnected__");
    createdMerchantIds.push(connected.id, unconnected.id);

    const res = await GET(req("/.well-known/agent-commerce.json"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("agent-commerce-directory");

    const ids = body.merchants.map((m: { id: string }) => m.id);
    expect(ids).toContain(connected.id);
    expect(ids).not.toContain(unconnected.id);
  });

  it("every merchant's manifestUrl in the directory actually resolves to a real manifest", async () => {
    const merchant = await createTestMerchant("__wellknown_reachable__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchant.id);

    const res = await GET(req("/.well-known/agent-commerce.json"));
    const body = await res.json();
    const entry = body.merchants.find((m: { id: string }) => m.id === merchant.id);
    expect(entry).toBeTruthy();

    const path = new URL(entry.manifestUrl).pathname;
    const manifestRes = await manifestGET(req(path), { params: Promise.resolve({ merchantId: merchant.id }) });
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json();
    expect(manifest.merchant.id).toBe(merchant.id);
  });

  it("the manifest's advertised MCP endpoint actually responds to a real handshake, not a 404", async () => {
    const merchant = await createTestMerchant("__wellknown_mcp_reachable__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchant.id);

    const manifestRes = await manifestGET(req(`/store/${merchant.id}/manifest.json`), { params: Promise.resolve({ merchantId: merchant.id }) });
    const manifest = await manifestRes.json();
    expect(manifest.agentAccess.mcp.endpoint).toMatch(/\/api\/mcp$/);

    // An unauthenticated MCP request should be REJECTED for lacking a
    // bearer key, never 404 — proving the endpoint itself exists and is wired up.
    const mcpReq = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const mcpRes = await mcpPOST(mcpReq);
    expect(mcpRes.status).not.toBe(404);
  });

  it("the manifest's advertised AP2 public key is a real SPKI PEM string", async () => {
    const merchant = await createTestMerchant("__wellknown_ap2_key__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchant.id);

    const manifestRes = await manifestGET(req(`/store/${merchant.id}/manifest.json`), { params: Promise.resolve({ merchantId: merchant.id }) });
    const manifest = await manifestRes.json();
    expect(manifest.protocolSupport.ap2.implemented).toBe(true);
    expect(manifest.protocolSupport.ap2.publicKey.value).toMatch(/BEGIN PUBLIC KEY/);
    expect(manifest.protocolSupport.acp.implemented).toBe(false);
    expect(manifest.protocolSupport.npciUap.implemented).toBe(false);
  });

  it("rate-limits repeated requests from the same IP", async () => {
    const many = Array.from({ length: 35 }, () =>
      GET(new NextRequest("http://localhost/.well-known/agent-commerce.json", { headers: { "x-forwarded-for": "203.0.113.7" } })),
    );
    const results = await Promise.all(many);
    expect(results.some((r) => r.status === 429)).toBe(true);
  });
});
