import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleChatTurn } from "@/lib/chat";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";

const chatRequestSchema = z.object({
  merchantId: z.string().uuid(),
  sessionToken: z.string().uuid(),
  message: z.string().min(1).max(1000),
});

// Public, unauthenticated, and hits the LLM on every call — the most
// pressing rate-limit case in this codebase. 20 messages/minute per IP
// is generous for a real conversation, tight against a script.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS" });
}

/**
 * The buyer chat's only endpoint (Layer 4-6). Public, no auth — the
 * storefront has no buyer login, a session is scoped by a browser-
 * generated token. Every reply is grounded in the real catalogue and
 * the cart is computed in code; see src/lib/chat.ts for the split.
 *
 * Layer 10 adds an optional embed path: a request carrying the
 * X-Embed-Key header is cross-origin (the embeddable widget on a
 * merchant's own site) and is subject to the origin allowlist in
 * resolveEmbedRequest before it's handled at all. A request with no
 * such header is untouched — same behaviour as before this layer
 * existed. The key travels as a header, not a body field, because a
 * real CORS preflight (OPTIONS) carries no body — see embed-cors.ts.
 */
export async function POST(req: NextRequest) {
  const rateLimit = await checkRateLimit(`chat:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
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

  const { merchantId, sessionToken, message } = parsed.data;

  const embedResolution = await resolveEmbedRequest(req, merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }

  const result = await handleChatTurn(merchantId, sessionToken, message);

  return NextResponse.json(result, {
    headers: embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined,
  });
}
