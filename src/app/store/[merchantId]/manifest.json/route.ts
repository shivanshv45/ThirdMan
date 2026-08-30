import { NextRequest, NextResponse } from "next/server";
import { buildMerchantManifest } from "@/lib/discovery-manifest";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * The public agent-discovery surface (Layer 5-5, extended Layer 21-2).
 * L5-4's MCP server serves agents that already hold an agent key; this
 * serves agents that don't yet — a crawler or an agent landing on the
 * storefront URL can fetch this without authenticating and learn what
 * the merchant sells, their terms, and how to get transacting access.
 *
 * Read-only, and includes real prices — those are already public on the
 * storefront page itself, so publishing them here again isn't a new
 * disclosure (see DECISIONS.md). Never costPaise, which is
 * internal-only regardless of surface.
 *
 * Layer 21 update: this document now names the SPECIFIC documented
 * subset of AP2 (Checkout/Payment Mandate verification) and x402 (the
 * 402 challenge shape) this product actually implements — see
 * discovery-manifest.ts and DECISIONS.md. It still claims no conformance
 * to ACP or NPCI's UAP, neither of which is implemented. See
 * plans/layer-21-protocol-surface.md.
 */

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ merchantId: string }> }) {
  const rateLimit = await checkRateLimit(`manifest:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const { merchantId } = await params;
  const manifest = await buildMerchantManifest(merchantId, req.nextUrl.origin);
  if (!manifest) {
    return NextResponse.json({ error: "merchant not found" }, { status: 404 });
  }

  return NextResponse.json(manifest);
}
