import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { openReturnRequest, resolveContactRequesterForMoneyAction } from "@/lib/returns-desk";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const openRequestSchema = z.object({
  merchantId: z.string().uuid(),
  moneyActionId: z.string().uuid(),
  email: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Layer 22 — opens a return request from the storefront (a human
 * buyer's path into the returns desk; an agent's path is the MCP
 * open_return_request tool instead). Public, unauthenticated — a buyer
 * has no account — but the only identity this accepts is the email
 * already on file for that exact purchase's conversation, never a
 * caller-asserted contactId. Every eligibility check in
 * checkReturnEligibility runs before a single model token is spent.
 */
export async function POST(req: NextRequest) {
  const rateLimit = await checkRateLimit(`returns-open:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = openRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { merchantId, moneyActionId, email, reason } = parsed.data;

  const contact = await resolveContactRequesterForMoneyAction(merchantId, moneyActionId, email);
  if (!contact) {
    return NextResponse.json({ status: "refused", reason: "We couldn't verify that email against this purchase." });
  }

  const result = await openReturnRequest(merchantId, moneyActionId, { contactId: contact.contactId }, reason);
  return NextResponse.json(result);
}
