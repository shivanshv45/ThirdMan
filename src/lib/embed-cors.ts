import { NextRequest, NextResponse } from "next/server";
import { isOriginAllowed, resolveEmbedKey, type EmbedConfig } from "@/lib/embed";
import { logAuditEntry } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Shared cross-origin handling for the buyer endpoints the embeddable
 * widget calls (see plans/layer-10-embeddable-commerce.md's L10-3).
 *
 * The compatibility guarantee this file exists to protect: a request
 * with NO embed key behaves exactly as it did before this layer existed
 * — same-origin /store/[merchantId] traffic sends no embedKey and gets
 * no CORS headers, and nothing about its handling changes. Every route
 * that imports this module must preserve that "not-an-embed" path
 * completely untouched.
 */

export type EmbedRequestResolution =
  | { ok: true; config: EmbedConfig; origin: string }
  | { ok: false; reason: string }
  | { ok: "not-an-embed" };

const ORIGIN_DENY_RATE_LIMIT_MAX = 20;
const ORIGIN_DENY_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Resolves an embed-tagged request against the merchant it claims to be
 * for. `embedKey` absent entirely means "not an embed request" — the
 * legacy, unchanged path. `embedKey` present but invalid, mismatched,
 * or from a disallowed origin is always a deny, never silently ignored
 * back into the legacy path (that would let a caller strip its own key
 * to bypass origin enforcement).
 */
export async function resolveEmbedRequest(req: NextRequest, embedKey: string | undefined, merchantId: string): Promise<EmbedRequestResolution> {
  if (!embedKey) return { ok: "not-an-embed" };

  const requestOrigin = req.headers.get("origin");
  const config = await resolveEmbedKey(embedKey);

  if (!config) {
    return { ok: false, reason: "Unknown or disabled embed key." };
  }

  if (config.merchantId !== merchantId) {
    return { ok: false, reason: "This embed key does not belong to the requested merchant." };
  }

  if (!isOriginAllowed(config, requestOrigin)) {
    await logOriginDenial(req, config.merchantId, requestOrigin);
    return { ok: false, reason: requestOrigin ? `Origin "${requestOrigin}" is not on this merchant's embed allowlist.` : "Missing Origin header." };
  }

  return { ok: true, config, origin: requestOrigin! };
}

async function logOriginDenial(req: NextRequest, merchantId: string, requestOrigin: string | null) {
  // Rate-limited by origin (falling back to IP when there's no Origin
  // header at all) so a hostile page hammering a denied origin can't
  // flood the audit log — an unbounded write triggered by an
  // unauthenticated cross-origin request is a log-flooding vector.
  const limitKey = `embed-origin-denied:${requestOrigin ?? getClientIp(req.headers)}`;
  const { allowed } = checkRateLimit(limitKey, 5, 60_000);
  if (!allowed) return;

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "embed_origin_denied",
    decision: "deny",
    reason: requestOrigin
      ? `Denied an embed request from origin "${requestOrigin}" — not on this merchant's allowed-origins list.`
      : "Denied an embed request with no Origin header.",
    boundApplied: `embed_allowed_origins:${requestOrigin ?? "(none)"}`,
  });
}

/** CORS response headers for a successfully-resolved embed request. Never "*" — the origin is echoed back exactly, and Vary: Origin stops a cache from serving one merchant's allowed origin to another's request. */
export function embedCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "false",
    Vary: "Origin",
  };
}

/**
 * A uniform preflight handler for routes that accept embed traffic.
 * Applies the identical resolution logic the POST handler uses — a
 * preflight that allows what the POST would deny is a bug, so both call
 * this same function rather than keeping two copies that can drift.
 */
export async function handleEmbedPreflight(
  req: NextRequest,
  opts: { methods: string; extractMerchantId: (req: NextRequest) => Promise<string | null> },
): Promise<NextResponse> {
  const requestOrigin = req.headers.get("origin");
  if (!requestOrigin) return new NextResponse(null, { status: 204 });

  const merchantId = await opts.extractMerchantId(req);
  const embedKey = req.headers.get("x-embed-key") ?? undefined;

  if (!merchantId || !embedKey) return new NextResponse(null, { status: 204 });

  const resolution = await resolveEmbedRequest(req, embedKey, merchantId);
  if (resolution.ok !== true) return new NextResponse(null, { status: 204 });

  return new NextResponse(null, {
    status: 204,
    headers: {
      ...embedCorsHeaders(resolution.origin),
      "Access-Control-Allow-Methods": opts.methods,
      "Access-Control-Allow-Headers": "Content-Type, X-Embed-Key",
      "Access-Control-Max-Age": "600",
    },
  });
}
