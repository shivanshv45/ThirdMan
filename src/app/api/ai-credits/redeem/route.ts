import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redeemAiCredit } from "@/lib/ai-credits";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";

const redeemRequestSchema = z.object({
  merchantId: z.string().uuid(),
  sessionToken: z.string().uuid(),
  tierId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(2000),
});

// Coin price already caps API-cost exposure per request, but a large
// balance shouldn't be convertible into a burst of calls in one minute
// on the free tier — same reasoning as redeem-coins' own limit.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS" });
}

/**
 * Layer 11-8: spends reward coins for one AI response at a merchant-
 * configured tier. Same structure as /api/checkout/redeem-coins —
 * resolves the hidden storefront agent so a session-only buyer still
 * answers to a real, visible spend cap, then defers the actual balance
 * check, debit, model call, and refund-on-failure entirely to
 * ai-credits.ts. This route validates and rate-limits; it decides
 * nothing about coins or money.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`ai-credits-redeem:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = redeemRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { merchantId, sessionToken, tierId, prompt } = parsed.data;

  const embedResolution = await resolveEmbedRequest(req, merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }
  const corsHeaders = embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined;

  const storefrontAgent = await getOrCreateStorefrontAgent(merchantId);

  const result = await redeemAiCredit(merchantId, storefrontAgent.id, tierId, { sessionToken }, prompt);

  return NextResponse.json(result, { status: 200, headers: corsHeaders });
}
