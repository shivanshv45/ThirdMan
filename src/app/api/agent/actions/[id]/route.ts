import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";

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

  return NextResponse.json({
    id: action.id,
    type: action.type,
    amountPaise: action.amountPaise,
    status: action.status,
    razorpayOrderId: action.razorpayEntityId,
    createdAt: action.createdAt,
  });
}
