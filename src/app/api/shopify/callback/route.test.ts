import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { GET } from "./route";

/**
 * L24-3's OAuth callback. shopify.test.ts already covers
 * completeShopifyInstall's own logic directly (including the real
 * state/token-exchange round trip against a local test server); this
 * covers the route's own concerns — missing params fail closed to a
 * redirect back to the dashboard rather than a raw error, matching
 * src/app/api/auth/[provider]/callback's own posture.
 */

const merchantIds: string[] = [];

afterEach(async () => {
  const ids = [...merchantIds];
  merchantIds.length = 0;
  for (const id of ids) {
    await db.delete(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

describe("GET /api/shopify/callback", () => {
  it("missing shop/code/state redirects back to the dashboard with an error, never a raw 500", async () => {
    const res = await GET(new NextRequest("http://localhost/api/shopify/callback"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/dashboard/integrations");
    expect(location).toContain("shopifyError=");
  });

  it("a fabricated state redirects with an honest error, never connects anything", async () => {
    const res = await GET(new NextRequest("http://localhost/api/shopify/callback?shop=test-store.myshopify.com&code=abc&state=never_minted"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("shopifyError=");
  });

  it("a real state row from a different shop than the callback's own is refused, never silently trusted", async () => {
    const merchant = await createTestMerchant("__shopify_callback_route_test__");
    merchantIds.push(merchant.id);

    const state = `route_test_state_${Date.now()}`;
    await db.insert(schema.shopifyInstallStates).values({
      state,
      merchantId: merchant.id,
      shopDomain: "the-real-shop.myshopify.com",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const res = await GET(new NextRequest(`http://localhost/api/shopify/callback?shop=a-different-shop.myshopify.com&code=abc&state=${state}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("shopifyError=");
  });
});
