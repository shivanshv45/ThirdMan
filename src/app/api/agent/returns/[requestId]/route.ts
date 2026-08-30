import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";

/** REST equivalent of the MCP get_return_status tool (Layer 22-6). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { requestId } = await params;
  if (!z.string().uuid().safeParse(requestId).success) {
    return NextResponse.json({ error: "invalid requestId" }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(schema.returnRequests)
    .where(and(eq(schema.returnRequests.id, requestId), eq(schema.returnRequests.merchantId, agent.merchantId), eq(schema.returnRequests.requesterAgentId, agent.id)));

  if (!row) {
    return NextResponse.json({ error: "No return request found with that id for this agent." }, { status: 404 });
  }

  return NextResponse.json({
    status: row.status,
    resolutionReason: row.resolutionReason,
    approvedAmountPaise: row.approvedAmountPaise,
    expiresAt: row.expiresAt,
  });
}
