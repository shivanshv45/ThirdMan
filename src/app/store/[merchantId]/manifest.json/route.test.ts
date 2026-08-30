import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { GET } from "./route";

/**
 * L5-5: the public, unauthenticated agent-discovery manifest. What
 * matters: it never exposes costPaise, a bad merchant id is a clean
 * 404 (not a crash), and every promised field the plan names (merchant,
 * catalogue summary, policy, MCP endpoint) is actually present.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const products = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.merchantId, merchantId));
    const productIds = products.map((p) => p.id);
    if (productIds.length > 0) {
      await db.delete(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId));
      await db.delete(schema.products).where(eq(schema.products.merchantId, merchantId));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

function manifestRequest(merchantId: string) {
  return new NextRequest(`http://localhost/store/${merchantId}/manifest.json`);
}

describe("GET /store/[merchantId]/manifest.json", () => {
  it("returns 404 for an unknown merchant id, not a crash", async () => {
    const res = await GET(manifestRequest("00000000-0000-0000-0000-000000000000"), { params: Promise.resolve({ merchantId: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
  });

  it("includes merchant, catalogue summary, policy, and MCP agent-access fields", async () => {
    const merchant = await createTestMerchant("__manifest_test__");
    createdMerchantIds.push(merchant.id);

    const [product] = await db.insert(schema.products).values({ merchantId: merchant.id, name: "Manifest Test Product", description: "test", status: "active" }).returning();
    await db.insert(schema.productVariants).values({
      productId: product.id,
      merchantId: merchant.id,
      sku: `MANIFEST-${Date.now()}`,
      pricePaise: 45_000,
      costPaise: 20_000,
      stock: 5,
      status: "active",
    });

    const res = await GET(manifestRequest(merchant.id), { params: Promise.resolve({ merchantId: merchant.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.merchant.id).toBe(merchant.id);
    expect(body.merchant.name).toBe(merchant.name);
    expect(body.catalogueSummary.productCount).toBe(1);
    expect(body.catalogueSummary.priceRangePaise).toEqual({ min: 45_000, max: 45_000 });
    expect(body.policy.published).toBe(false);
    expect(body.agentAccess.mcp.endpoint).toMatch(/\/api\/mcp$/);
    expect(body.agentAccess.mcp.transport).toBe("streamable-http");
    expect(body.protocolSupport.ap2.implemented).toBe(true);
    expect(body.protocolSupport.acp.implemented).toBe(false);

    expect(JSON.stringify(body)).not.toMatch(/costPaise|20000/); // costPaise value never leaks
  });
});
