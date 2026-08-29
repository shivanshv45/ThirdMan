import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, extractBearerKey, requireCapability } from "@/lib/agent-auth";
import { getPublicCatalogue } from "@/lib/storefront-catalogue";

/**
 * An agent cannot buy from a catalogue it can't read. Scoped to the
 * authenticated agent's own merchant — same isolation standard as every
 * other agent-facing route. Never returns costPaise (internal-only, see
 * dashboard-mutations.ts). This is also the natural seed of §1's
 * agent-readable catalogue in a later layer, so the response shape is
 * kept clean and stable rather than reshaped ad hoc there.
 */
export async function GET(req: NextRequest) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  if (!(await requireCapability(agent, "products:read"))) {
    return NextResponse.json({ error: "This agent does not hold the products:read capability." }, { status: 403 });
  }

  const products = await getPublicCatalogue(agent.merchantId);
  return NextResponse.json({ products });
}
