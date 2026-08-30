import { NextRequest, NextResponse } from "next/server";
import { requireSessionMerchant } from "@/lib/auth";
import { beginShopifyInstall, isValidShopDomain } from "@/lib/shopify";

/**
 * L24-3: starts the install. A top-level navigation (GET, not a fetch)
 * because Shopify's OAuth consent screen, like Google/GitHub's, refuses
 * to render inside anything but a real browser navigation — same
 * reasoning as src/app/api/auth/[provider]/start/route.ts.
 */
export async function GET(req: NextRequest) {
  const merchant = await requireSessionMerchant();

  const shopDomain = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase() ?? "";
  if (!isValidShopDomain(shopDomain)) {
    return NextResponse.redirect(new URL("/dashboard/integrations?shopifyError=" + encodeURIComponent("Enter your shop domain as your-store.myshopify.com."), req.url));
  }

  try {
    const authorizeUrl = await beginShopifyInstall(merchant.id, shopDomain);
    return NextResponse.redirect(authorizeUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start the Shopify install.";
    return NextResponse.redirect(new URL("/dashboard/integrations?shopifyError=" + encodeURIComponent(message), req.url));
  }
}
