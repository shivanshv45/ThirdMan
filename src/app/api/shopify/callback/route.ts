import { NextRequest, NextResponse } from "next/server";
import { completeShopifyInstall } from "@/lib/shopify";

const GENERIC_ERROR = "Could not connect that Shopify store. Please try again.";

function fail(req: NextRequest, message = GENERIC_ERROR) {
  return NextResponse.redirect(new URL(`/dashboard/integrations?shopifyError=${encodeURIComponent(message)}`, req.url));
}

/**
 * Shopify's redirect back with a code. Fail-closed on anything
 * unexpected, same posture as src/app/api/auth/[provider]/callback —
 * the actual state-validate/token-exchange/store decision lives in
 * completeShopifyInstall (shopify.ts) so it's testable without a real
 * Shopify round-trip.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!shop || !code || !state) {
    return fail(req);
  }

  let result;
  try {
    result = await completeShopifyInstall(shop, code, state);
  } catch (err) {
    console.error("[shopify] callback failed:", err);
    return fail(req);
  }

  if (result.outcome === "invalid_state") {
    return fail(req, "That install link expired or was already used. Start again from the dashboard.");
  }
  if (result.outcome === "shop_already_connected") {
    return fail(req, "That Shopify store is already connected to a different account.");
  }

  return NextResponse.redirect(new URL("/dashboard/integrations?shopifyConnected=1", req.url));
}
