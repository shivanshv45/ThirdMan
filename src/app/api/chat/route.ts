import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleChatTurn } from "@/lib/chat";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";

const chatRequestSchema = z.object({
  merchantId: z.string().uuid(),
  sessionToken: z.string().uuid(),
  message: z.string().min(1).max(1000),
  // Layer 10: present only when the caller is the embeddable widget on
  // a third-party origin — see embed-cors.ts. Absent, this route
  // behaves exactly as it always has (no CORS headers, no origin check).
  embedKey: z.string().optional(),
});

// Public, unauthenticated, and hits the LLM on every call — the most
// pressing rate-limit case in this codebase. 20 messages/minute per IP
// is generous for a real conversation, tight against a script.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

async function extractMerchantId(req: NextRequest): Promise<string | null> {
  try {
    const body = await req.clone().json();
    return typeof body?.merchantId === "string" ? body.merchantId : null;
  } catch {
    return null;
  }
}

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS", extractMerchantId });
}

/**
 * The buyer chat's only endpoint (Layer 4-6). Public, no auth — the
 * storefront has no buyer login, a session is scoped by a browser-
 * generated token. Every reply is grounded in the real catalogue and
 * the cart is computed in code; see src/lib/chat.ts for the split.
 *
 * Layer 10 adds an optional embed path: a request carrying embedKey is
 * cross-origin (the embeddable widget on a merchant's own site) and is
 * subject to the origin allowlist in resolveEmbedRequest before it's
 * handled at all. A request with no embedKey is untouched — same
 * behaviour as before this layer existed.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`chat:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many messages. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { merchantId, sessionToken, message, embedKey } = parsed.data;

  const embedResolution = await resolveEmbedRequest(req, embedKey, merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }

  const result = await handleChatTurn(merchantId, sessionToken, message);

  return NextResponse.json(result, {
    headers: embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined,
  });
}
