import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey, requireCapability } from "@/lib/agent-auth";
import { attemptMoneyAction } from "@/lib/gate";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Layer 13-5: preflight/dry-run. Exposes the REAL decision path
 * (capability check, Guardian state, checkBounds — spend cap, stock,
 * price match) as a non-executing simulation. The one rule that makes
 * this honest, per the plan: this route calls the exact same code an
 * agent's real /api/agent/purchase call would, via
 * attemptMoneyAction({ ..., dryRun: true }) — never a parallel
 * reimplementation of the rules that could drift.
 *
 * Not rate-limited as tightly as the real purchase endpoint (no
 * Razorpay call, no live risk-layer model call), but still bounded —
 * an agent probing thresholds repeatedly is still real load.
 */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

const preflightRequestSchema = z
  .object({
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().positive().max(999).optional(),
    amountPaise: z.number().int().positive().optional(),
    context: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.variantId !== undefined || (v.amountPaise !== undefined && v.context !== undefined), {
    message: "either variantId, or both amountPaise and context, is required",
  });

export async function POST(req: NextRequest) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  // A preflight check on the purchase path only makes sense for an
  // agent that could actually purchase — same capability the real
  // route requires, so a preflight never tells an agent "this would be
  // allowed" for an action it structurally cannot take.
  if (!(await requireCapability(agent, "purchase:create"))) {
    return NextResponse.json({ error: "This agent does not hold the purchase:create capability." }, { status: 403 });
  }

  const rateLimit = await checkRateLimit(`agent-preflight:${agent.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = preflightRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { variantId, quantity } = parsed.data;
  let { amountPaise, context } = parsed.data;

  if (variantId) {
    const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId));
    if (!variant || variant.merchantId !== agent.merchantId) {
      return NextResponse.json({ decision: "deny", reason: `No product ${variantId} found for this merchant.` }, { status: 200 });
    }
    context ??= `Preflight: ${variant.sku}`;
    amountPaise ??= variant.pricePaise * (quantity ?? 1);
  }

  const result = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: agent.merchantId,
    type: "order_create",
    amountPaise: amountPaise!,
    context: context!,
    variantId,
    quantity,
    dryRun: true,
  });

  return NextResponse.json(
    {
      ...result,
      mandateWouldBeRequired: agent.mandateRequired,
      note: "This was a simulation. Nothing was reserved or executed. The risk layer's live judgment on escalation is not simulated — a real attempt could still escalate even when this says it would allow.",
    },
    { status: 200 },
  );
}
