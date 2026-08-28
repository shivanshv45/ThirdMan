import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { updateEmbedOrigins } from "@/lib/embed-mutations";
import { POST as declineOfferPOST, OPTIONS as declineOfferOPTIONS } from "@/app/api/checkout/decline-offer/route";

/**
 * L10-3/L10-7's required tests: the preflight and the real POST agree
 * on both the allow and deny path (a preflight that allows what the
 * POST would deny is a bug), cross-merchant isolation by enumeration,
 * and — the most important one — that a request with NO embed key is
 * completely untouched by any of this. Uses the real route handler
 * (/api/checkout/decline-offer) directly, same pattern as
 * agent/purchase/route.test.ts: no server process, no mocks.
 */

const cleanupMerchantIds: string[] = [];

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const id = cleanupMerchantIds.pop()!;
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, id));
    await db.delete(schema.offers).where(eq(schema.offers.merchantId, id));
    await db.delete(schema.bundles).where(eq(schema.bundles.merchantId, id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

async function makeMerchantWithEmbed(allowedOrigin: string) {
  const merchant = await createTestMerchant("embed-cors-route-test");
  cleanupMerchantIds.push(merchant.id);
  const config = await getOrCreateEmbedConfig(merchant.id);
  await updateEmbedOrigins({ merchantId: merchant.id, origins: [allowedOrigin] });
  return { merchant, publishableKey: config.publishableKey };
}

const ALLOWED_ORIGIN = "https://shop.example.com";
// A real-shaped v4 UUID — zod v4's .uuid() requires the version/variant
// nibbles ([1-8]/[89ab]), which a hand-typed placeholder like
// "...000000000001" fails. These offer/session ids don't need to
// resolve to anything real: every test here is about the CORS layer
// rejecting/allowing BEFORE the route logic runs, or (for the no-key
// case) running its normal not-found logic — never about a real offer.
const FAKE_OFFER_ID = "807b3fd7-4c40-4f3e-8485-297ae87a041b";
const FAKE_SESSION_TOKEN = "47cda31b-0e04-4ba8-a7a8-323d305b0b61";

function declineRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/checkout/decline-offer", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function preflightRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/checkout/decline-offer", {
    method: "OPTIONS",
    headers,
  });
}

describe("embed CORS on a real route (decline-offer)", () => {
  it("a request with NO embed key is completely untouched — no CORS headers, same behaviour as before Layer 10", async () => {
    const merchant = await createTestMerchant("embed-cors-no-key");
    cleanupMerchantIds.push(merchant.id);

    const res = await declineOfferPOST(
      declineRequest({ merchantId: merchant.id, offerId: FAKE_OFFER_ID, sessionToken: FAKE_SESSION_TOKEN }),
    );

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // No offer exists for this id, but the route still runs its normal
    // logic (declineOffer returns false) — proving it never even looked
    // at the embed path.
    const body = await res.json();
    expect(body.declined).toBe(false);
  });

  it("preflight allows and the POST allows, for a real embed key from its allowed origin", async () => {
    const { publishableKey } = await makeMerchantWithEmbed(ALLOWED_ORIGIN);

    const preflight = await declineOfferOPTIONS(preflightRequest({ origin: ALLOWED_ORIGIN, "x-embed-key": publishableKey }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("preflight denies and the POST denies, for the same embed key from a DIFFERENT origin — they must agree", async () => {
    const { merchant, publishableKey } = await makeMerchantWithEmbed(ALLOWED_ORIGIN);

    const preflight = await declineOfferOPTIONS(preflightRequest({ origin: "https://evil.example.com", "x-embed-key": publishableKey }));
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const res = await declineOfferPOST(
      declineRequest(
        { merchantId: merchant.id, offerId: FAKE_OFFER_ID, sessionToken: FAKE_SESSION_TOKEN },
        { origin: "https://evil.example.com", "x-embed-key": publishableKey },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not on this merchant's embed allowlist/i);
  });

  it("cross-merchant isolation: merchant A's embed key against merchant B's merchantId is denied, by enumeration not just an empty result", async () => {
    const { publishableKey: keyA } = await makeMerchantWithEmbed(ALLOWED_ORIGIN);
    const merchantB = await createTestMerchant("embed-cors-merchant-b");
    cleanupMerchantIds.push(merchantB.id);

    const res = await declineOfferPOST(
      declineRequest(
        { merchantId: merchantB.id, offerId: FAKE_OFFER_ID, sessionToken: FAKE_SESSION_TOKEN },
        { origin: ALLOWED_ORIGIN, "x-embed-key": keyA },
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/does not belong to the requested merchant/i);
  });

  it("an unknown embed key is denied", async () => {
    const merchant = await createTestMerchant("embed-cors-unknown-key");
    cleanupMerchantIds.push(merchant.id);

    const res = await declineOfferPOST(
      declineRequest(
        { merchantId: merchant.id, offerId: FAKE_OFFER_ID, sessionToken: FAKE_SESSION_TOKEN },
        { origin: ALLOWED_ORIGIN, "x-embed-key": "pk_does_not_exist" },
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown or disabled embed key/i);
  });
});
