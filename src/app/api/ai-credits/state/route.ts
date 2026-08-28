import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEnabledTiers } from "@/lib/ai-credits";
import { getRewardBalance } from "@/lib/reward-actions";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { embedCorsHeaders, handleEmbedPreflight, resolveEmbedRequest } from "@/lib/embed-cors";

const stateRequestSchema = z.object({
  merchantId: z.string().uuid(),
  sessionToken: z.string().uuid(),
});

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function OPTIONS(req: NextRequest) {
  return handleEmbedPreflight(req, { methods: "POST, OPTIONS" });
}

/** Read-only: a buyer's real coin balance and the merchant's real, enabled AI-credit tiers — never a sample balance or a placeholder tier list. POST (not GET) only so the embed CORS/rate-limit helpers this file reuses stay consistent with every other buyer-facing route; nothing here writes anything. */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`ai-credits-state:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = stateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { merchantId, sessionToken } = parsed.data;

  const embedResolution = await resolveEmbedRequest(req, merchantId);
  if (embedResolution.ok === false) {
    return NextResponse.json({ error: embedResolution.reason }, { status: 400 });
  }
  const corsHeaders = embedResolution.ok === true ? embedCorsHeaders(embedResolution.origin) : undefined;

  const [balance, tiers] = await Promise.all([
    getRewardBalance(merchantId, { sessionToken }),
    getEnabledTiers(merchantId),
  ]);

  return NextResponse.json(
    {
      balance: balance.balance,
      enabled: balance.enabled,
      tiers: tiers.map((t) => ({ id: t.id, displayName: t.displayName, coinsPerRequest: t.coinsPerRequest })),
    },
    { status: 200, headers: corsHeaders },
  );
}
