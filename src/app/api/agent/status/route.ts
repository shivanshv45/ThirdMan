import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";

export async function GET(req: NextRequest) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  if (agent.status !== "active") {
    return NextResponse.json({
      agentId: agent.id,
      agentStatus: agent.status,
      spendCap: null,
    });
  }

  const [cap] = await db
    .select()
    .from(schema.spendCaps)
    .where(eq(schema.spendCaps.agentId, agent.id))
    .orderBy(desc(schema.spendCaps.createdAt))
    .limit(1);

  if (!cap) {
    return NextResponse.json({ agentId: agent.id, agentStatus: agent.status, spendCap: null });
  }

  return NextResponse.json({
    agentId: agent.id,
    agentStatus: agent.status,
    spendCap: {
      id: cap.id,
      status: cap.status,
      capPaise: cap.capPaise,
      spentPaise: cap.spentPaise,
      remainingPaise: Math.max(cap.capPaise - cap.spentPaise, 0),
      perTransactionMaxPaise: cap.perTransactionMaxPaise,
      windowStart: cap.windowStart,
      windowEnd: cap.windowEnd,
    },
  });
}
