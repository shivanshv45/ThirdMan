import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { declineOffer } from "@/lib/discount";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const declineRequestSchema = z.object({
  merchantId: z.string().uuid(),
  offerId: z.string().uuid(),
  sessionToken: z.string().uuid(),
});

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * A buyer declining an upsell offer (Layer 6-3) — no money moves here,
 * so this doesn't touch the gate. Declining must be exactly one click
 * and must never be a dark pattern; this is that click. The engine
 * itself already recorded the offer in offer_decisions when it was
 * made — this only updates the offer's own resolution.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(`decline-offer:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = declineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const declined = await declineOffer(parsed.data.merchantId, parsed.data.offerId, { sessionToken: parsed.data.sessionToken });

  return NextResponse.json({ declined });
}
