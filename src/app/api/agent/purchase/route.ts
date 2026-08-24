import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";
import { attemptMoneyAction } from "@/lib/gate";

const purchaseRequestSchema = z.object({
  amountPaise: z.number().int().positive(),
  context: z.string().min(1).max(500),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/**
 * A denial is a successful response, not an HTTP error — the reason is
 * for the agent to read and act on. An agent that gets a 500 cannot
 * distinguish "you are over budget" from "the server is broken."
 */
export async function POST(req: NextRequest) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = purchaseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: agent.merchantId,
    type: "order_create",
    amountPaise: parsed.data.amountPaise,
    context: parsed.data.context,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  return NextResponse.json(result, { status: 200 });
}
