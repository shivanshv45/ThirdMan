import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";
import { attemptMoneyAction } from "@/lib/gate";
import { checkRateLimit } from "@/lib/rate-limit";

// Keyed by agent id, not IP — an authenticated agent can legitimately
// call this from a shared or rotating IP, and the spend cap already
// bounds financial exposure. This limit exists to bound the load an
// agent can put on the gate's risk layer (a real Groq call per attempt)
// and Razorpay, not to bound spend, which the cap already does.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * v2 (Layer 4-4, updated Layer 5-1): buy a specific variant by id, not an
 * arbitrary number. The v1 shape (amountPaise + free-text context, no
 * variantId) still works — amountPaise alone lets an agent name its own
 * price for an unlisted spend (e.g. escrow, a non-catalogue action a
 * later layer adds), which is a legitimate use the gate has always
 * supported. What's new is that when variantId is given, amountPaise (if
 * also given) becomes an assertion the gate checks and denies on
 * mismatch, never the source of truth — see gate.ts's resolveVariant.
 */
const purchaseRequestSchema = z
  .object({
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().positive().max(999).optional(),
    amountPaise: z.number().int().positive().optional(),
    context: z.string().min(1).max(500).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    /** Escrow (Layer 4-5): authorise the payment but don't auto-capture it — held until the merchant releases or refunds it. */
    holdOnly: z.boolean().optional(),
  })
  .refine((v) => v.variantId !== undefined || (v.amountPaise !== undefined && v.context !== undefined), {
    message: "either variantId, or both amountPaise and context, is required",
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

  const rateLimit = checkRateLimit(`agent-purchase:${agent.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
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

  const parsed = purchaseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { variantId, quantity, idempotencyKey, holdOnly } = parsed.data;
  let { amountPaise, context } = parsed.data;

  if (variantId) {
    const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId));
    if (!variant || variant.merchantId !== agent.merchantId) {
      return NextResponse.json({ decision: "deny", reason: `No product ${variantId} found for this merchant.` }, { status: 200 });
    }
    // Price always comes from the catalogue — this is only the context
    // sentence for the audit trail. If the caller also asserted an
    // amountPaise, it's passed through unchanged so the gate can catch a
    // mismatch, rather than silently overwritten here.
    context ??= `Agent purchase: ${variant.sku}`;
    amountPaise ??= variant.pricePaise * (quantity ?? 1);
  }

  const result = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: agent.merchantId,
    type: "order_create",
    amountPaise: amountPaise!,
    context: context!,
    idempotencyKey,
    variantId,
    quantity,
    holdOnly,
  });

  return NextResponse.json(result, { status: 200 });
}
