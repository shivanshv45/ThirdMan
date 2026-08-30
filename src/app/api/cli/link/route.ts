import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redeemCliLinkToken } from "@/lib/cli-link";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Layer 20-6: the CLI redeems a merchant-generated link token here,
 * once, to receive a real agent key and (optionally) an origin
 * allowlist add. The token itself is the authentication — same
 * single-use, short-lived discipline as decision-share.ts's tokens, but
 * this one is deleted on redemption since it grants a mutation. Rate
 * limited per IP since an unauthenticated caller could otherwise brute
 * force token guesses (the token space is 24 random bytes, so this is
 * defense in depth, not the real protection).
 */

const RATE_LIMIT_MAX_PER_IP = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

const linkRequestSchema = z.object({
  token: z.string().min(1),
  agentName: z.string().min(1).max(200),
  origin: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const ipLimit = await checkRateLimit(`cli-link-ip:${ip}`, RATE_LIMIT_MAX_PER_IP, RATE_LIMIT_WINDOW_MS);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts from this address. Please slow down." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = linkRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await redeemCliLinkToken(parsed.data.token, parsed.data.agentName, parsed.data.origin ?? null);
  if (!result) {
    return NextResponse.json({ error: "This link token is invalid, expired, or already used. Generate a new one from /dashboard/cli." }, { status: 400 });
  }

  return NextResponse.json({
    merchantId: result.merchantId,
    merchantName: result.merchantName,
    agentId: result.agentId,
    agentName: result.agentName,
    apiKey: result.rawKey,
    note: "Store this key now — it is never shown again.",
  });
}
