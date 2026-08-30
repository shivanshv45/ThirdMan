import { NextRequest, NextResponse } from "next/server";
import { listMerchantsForDirectory } from "@/lib/discovery-manifest";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Layer 21-1: the conventional discovery location a crawler or agent
 * probes first, at the origin root. The per-merchant manifest at
 * /store/[merchantId]/manifest.json (Layer 5-5) keeps working unchanged
 * — this points at it.
 *
 * This deployment is genuinely multi-tenant on one origin, so there is
 * no single "the merchant" to resolve to at the root. The honest
 * response is a directory of what this origin actually serves, linking
 * to each real per-merchant manifest — not a query-param/subdomain
 * resolution to one merchant, and not a fabricated "default" that would
 * misrepresent a multi-tenant deployment as single-tenant. See
 * DECISIONS.md.
 *
 * Never costPaise — this document names merchants and manifest URLs
 * only, no catalogue or pricing data of its own.
 */

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(req: NextRequest) {
  const rateLimit = await checkRateLimit(`well-known-agent-commerce:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const merchants = await listMerchantsForDirectory(req.nextUrl.origin);

  return NextResponse.json({
    schemaVersion: "1.0",
    kind: "agent-commerce-directory",
    note: "This origin serves multiple independent merchants. This document lists them; each merchant's own manifest at manifestUrl carries its real catalogue, terms, and agent-access details.",
    merchants,
  });
}
