import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { runInstantAudit } from "@/lib/store-audit";

/**
 * Layer 24-1: the Instant Audit's only endpoint. Public, unauthenticated,
 * GET-only against the target — this route never writes to the target
 * site, never follows a form, never touches a checkout (see
 * store-fetch.ts's own fetching discipline). Rate-limited per caller IP
 * since this triggers real outbound fetches against a third party's
 * infrastructure on every call.
 */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

const auditRequestSchema = z.object({
  url: z.string().url().max(2048),
});

export async function POST(req: NextRequest) {
  const rateLimit = await checkRateLimit(`audit:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many audits. Please wait a moment and try again." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = auditRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid http(s) URL is required." }, { status: 400 });
  }

  try {
    const report = await runInstantAudit(parsed.data.url);
    return NextResponse.json(report);
  } catch (err) {
    console.error("[audit] run failed:", err);
    return NextResponse.json({ error: "Could not audit this URL." }, { status: 502 });
  }
}
