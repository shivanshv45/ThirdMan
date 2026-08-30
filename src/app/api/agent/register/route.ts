import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { registerAgent } from "@/lib/agent-registration";
import { merchantExists } from "@/lib/discovery-manifest";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Layer 21-8: self-serve agent registration — the loop L21-2's manifest
 * closes. An unauthenticated endpoint that creates a real row (an agent
 * plus a real spend cap) is the classic abuse surface, so it is
 * rate-limited hard, per IP AND per merchant — a single bad actor can't
 * flood one merchant's agent list even by rotating IPs slowly, and one
 * IP can't flood many merchants either. Both limits use the same
 * distributed limiter every other route does; its documented
 * single-instance-window-quantization limitation (rate-limit.ts) applies
 * here unchanged.
 *
 * registerAgent itself fails closed: no terms, or terms with
 * selfRegistrationOpen: false, both refuse outright. There is no
 * capability or cap this endpoint can grant beyond what the merchant
 * configured in their own agent terms — see agent-registration.ts.
 */

const RATE_LIMIT_MAX_PER_IP = 5;
const RATE_LIMIT_MAX_PER_MERCHANT = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000; // 1 hour — registration is rare by nature, unlike a purchase or a catalogue read

const registerRequestSchema = z.object({
  merchantId: z.string().uuid(),
  name: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);

  const ipLimit = await checkRateLimit(`agent-register-ip:${ip}`, RATE_LIMIT_MAX_PER_IP, RATE_LIMIT_WINDOW_MS);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts from this address. Please slow down." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = registerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { merchantId, name } = parsed.data;

  const merchantLimit = await checkRateLimit(`agent-register-merchant:${merchantId}`, RATE_LIMIT_MAX_PER_MERCHANT, RATE_LIMIT_WINDOW_MS);
  if (!merchantLimit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts for this merchant. Please slow down." },
      { status: 429, headers: { "Retry-After": String(merchantLimit.retryAfterSeconds) } },
    );
  }

  if (!(await merchantExists(merchantId))) {
    return NextResponse.json({ error: "merchant not found" }, { status: 404 });
  }

  const result = await registerAgent(merchantId, name, ip);
  if (!result.ok) {
    return NextResponse.json({ registered: false, reason: result.reason }, { status: 200 });
  }

  return NextResponse.json({
    registered: true,
    agentId: result.agent.id,
    apiKey: result.rawKey,
    note: "Store this key now — it is never shown again. This is a PROVISIONAL agent: a small, merchant-set starting cap and capability set. The merchant reviews and may raise limits based on real transaction history.",
  });
}
