import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

/**
 * L24-3's install-start route. shopify.test.ts already covers
 * beginShopifyInstall's own logic directly. This route calls
 * requireSessionMerchant() first, matching checkout/hold-order's own
 * pattern — outside a real Next.js request context (which no route
 * test in this codebase drives, since getSessionMerchant reads
 * next/headers' cookies()), that throws before the shop domain is ever
 * read. This test exists to catch the real regression that matters: if
 * someone ever removes the requireSessionMerchant() call, an
 * unauthenticated GET would stop throwing here.
 */
describe("GET /api/shopify/install", () => {
  it("throws before an authenticated merchant is resolved — requireSessionMerchant() gates every path through this route", async () => {
    const req = new NextRequest("http://localhost/api/shopify/install?shop=test-store.myshopify.com");
    await expect(GET(req)).rejects.toThrow();
  });
});
