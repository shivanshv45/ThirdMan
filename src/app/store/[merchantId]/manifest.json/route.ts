import { NextRequest, NextResponse } from "next/server";
import { getMerchantStorefrontInfo, getPublicCatalogue } from "@/lib/storefront-catalogue";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { env } from "@/lib/env";

/**
 * The public agent-discovery surface (Layer 5-5). L5-4's MCP server
 * serves agents that already hold an agent key; this serves agents that
 * don't yet — a crawler or an agent landing on the storefront URL can
 * fetch this without authenticating and learn what the merchant sells,
 * their terms, and how to get transacting access.
 *
 * Read-only, and includes real prices — those are already public on the
 * storefront page itself, so publishing them here again isn't a new
 * disclosure (see DECISIONS.md). Never costPaise, which is
 * internal-only regardless of surface.
 *
 * Deliberately not a claim of conformance to any external discovery
 * standard (ACP, AP2, x402, NPCI's UAP) — a clean, self-describing JSON
 * document plus a real MCP server is the substance here, not a spec this
 * project hasn't implemented. See plans/layer-5-agent-readable-catalog.md.
 */

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ merchantId: string }> }) {
  const rateLimit = checkRateLimit(`manifest:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const { merchantId } = await params;
  const merchant = await getMerchantStorefrontInfo(merchantId);
  if (!merchant) {
    return NextResponse.json({ error: "merchant not found" }, { status: 404 });
  }

  const [catalogue, policy] = await Promise.all([getPublicCatalogue(merchantId), getMerchantPolicy(merchantId)]);

  const origin = req.nextUrl.origin;

  return NextResponse.json({
    schemaVersion: "1.0",
    merchant: {
      id: merchant.id,
      name: merchant.name,
      storefrontUrl: `${origin}/store/${merchant.id}`,
      acceptingPayments: merchant.razorpayConnected,
    },
    catalogueSummary: {
      productCount: catalogue.length,
      variantCount: catalogue.reduce((sum, p) => sum + p.variants.length, 0),
      categories: [...new Set(catalogue.map((p) => p.category))],
      priceRangePaise:
        catalogue.length > 0
          ? {
              min: Math.min(...catalogue.flatMap((p) => p.variants.map((v) => v.pricePaise))),
              max: Math.max(...catalogue.flatMap((p) => p.variants.map((v) => v.pricePaise))),
            }
          : null,
    },
    policy: {
      published: policy !== null,
      summary: describeMerchantPolicy(policy),
    },
    agentAccess: {
      protocol: "mcp",
      transport: "streamable-http",
      endpoint: `${origin}/api/mcp`,
      authentication: "bearer",
      authenticationNote:
        "Requires an agent API key issued by this merchant via their dashboard — not a self-service OAuth flow. Contact the merchant to obtain one.",
      restApiBase: `${origin}/api/agent`,
    },
    note: env.NODE_ENV === "production" ? undefined : "Development build — pricing and availability shown are from real, non-production seed/test data.",
  });
}
