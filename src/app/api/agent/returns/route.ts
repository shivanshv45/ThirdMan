import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, extractBearerKey, requireCapability } from "@/lib/agent-auth";
import { openReturnRequest } from "@/lib/returns-desk";
import { checkRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const requestSchema = z.object({
  moneyActionId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

/**
 * The REST equivalent of the MCP open_return_request tool (Layer 22-6).
 * Same shape discipline as every other agent-facing route: a refusal is
 * a normal 200 response describing why, never a bare error, so an agent
 * can tell "ineligible" from "server broke." This can never return a
 * refund — refunds are not in the agent_capability enum at all.
 */
export async function POST(req: NextRequest) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(`agent-returns:${agent.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  if (!(await requireCapability(agent, "purchase:create"))) {
    return NextResponse.json({ status: "refused", reason: "This agent does not hold the purchase:create capability." });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await openReturnRequest(agent.merchantId, parsed.data.moneyActionId, { agentId: agent.id }, parsed.data.reason);
  return NextResponse.json(result);
}
