import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redeemRewardCoins } from "@/lib/reward-actions";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";

const redeemRequestSchema = z.object({
  merchantId: z.string().uuid(),
  sessionToken: z.string().uuid(),
  purchaseAmountPaise: z.number().int().positive(),
  coins: z.number().int().positive(),
});

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS" });
}

/**
 * Redeems reward coins as their own gated money action (Layer 6-5) —
 * bounded by the buyer's real ledger balance and the merchant's own
 * max-redemption-percent ceiling, both re-derived server-side, never
 * trusted from the request. Deliberately a standalone action rather than
 * a price reduction folded into /api/checkout/order: redemption and
 * purchase are two separate gated transactions, same as the recovery
 * pipeline keeps diagnosis and execution separate. Threading this into
 * the storefront's checkout UI as a single "pay partly with coins" step
 * is a real, noted gap — this endpoint makes the capability real and
 * independently testable without it.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`redeem-coins:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
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

  const { merchantId, sessionToken, purchaseAmountPaise, coins } = parsed.data;

  const embedResolution = await resolveEmbedRequest(req, merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }
  const corsHeaders = embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined;

  const storefrontAgent = await getOrCreateStorefrontAgent(merchantId);

  const result = await redeemRewardCoins(merchantId, storefrontAgent.id, purchaseAmountPaise, coins, { sessionToken });

  return NextResponse.json(result, { status: 200, headers: corsHeaders });
}
