import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { handleReturnDeskTurn } from "@/lib/returns-desk";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const turnSchema = z.object({
  merchantId: z.string().uuid(),
  message: z.string().min(1).max(1000),
});

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * One turn of the returns-desk conversation for an already-open request
 * (see /api/returns/open). Public — a buyer has no account — but scoped
 * to a real request id that already proved ownership at open time; a
 * fabricated or cross-merchant id here fails the same "not found" way
 * any other id-enumeration boundary in this codebase does.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!z.string().uuid().safeParse(requestId).success) {
    return NextResponse.json({ error: "invalid requestId" }, { status: 400 });
  }

  const rateLimit = await checkRateLimit(`returns-message:${getClientIp(req.headers)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many messages. Please slow down." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = turnSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const [request] = await db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.id, requestId));
  if (!request) {
    return NextResponse.json({ error: "Return request not found." }, { status: 404 });
  }

  try {
    const result = await handleReturnDeskTurn(parsed.data.merchantId, requestId, parsed.data.message);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not process message." }, { status: 404 });
  }
}
