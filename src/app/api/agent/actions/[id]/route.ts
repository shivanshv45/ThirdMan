import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";
import { getDecisionForMoneyAction } from "@/lib/explainability";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  const { id } = await params;

  const [action] = await db
    .select()
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.id, id), eq(schema.moneyActions.agentId, agent.id)));

  if (!action) {
    return NextResponse.json({ error: "no such action for this agent" }, { status: 404 });
  }

  // L7-5: if this action was refused or deferred, the caller can read
  // why — the same recorded reason a merchant sees on /dashboard/explain,
  // scoped to this agent's own action (getDecisionForMoneyAction checks
  // agentId again independently, not just this route's own lookup
  // above). A "why" section is only present when there's a decision to
  // show; an allowed/executed action has no refusal to explain.
  const decision = await getDecisionForMoneyAction(agent.merchantId, action.id, agent.id);

  return NextResponse.json({
    id: action.id,
    type: action.type,
    amountPaise: action.amountPaise,
    status: action.status,
    razorpayOrderId: action.razorpayEntityId,
    createdAt: action.createdAt,
    ...(decision && {
      why: {
        reason: decision.reason,
        bound: decision.boundLabel,
        determinism: decision.determinism,
        arithmetic: decision.arithmetic,
      },
    }),
  });
}
