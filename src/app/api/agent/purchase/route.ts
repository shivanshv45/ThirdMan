import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey, requireCapability } from "@/lib/agent-auth";
import { attemptMoneyAction } from "@/lib/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyPaymentMandate } from "@/lib/mandates";
import { issueRefusalReceipt } from "@/lib/refusal-receipt";
import { withMoneyPathSpan, withSpan } from "@/lib/tracing";
import { inspectInbound } from "@/lib/model-armor";

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
    /**
     * Layer 13-3: the Payment Mandate's checkout binding — the exact
     * Checkout JWT the merchant signed for this cart, obtained after the
     * agent got human approval. Required only when the calling agent has
     * mandateRequired set; omitted entirely for agents that don't opt in,
     * so existing demo flows are unaffected.
     */
    checkoutMandateJwt: z.string().min(1).optional(),
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
    // Layer 21-3: the x402 challenge shape, not a claim of the full x402
    // payment-settlement protocol. This is a REFUSAL TO CONSIDER a money
    // action at all — there is no agent identity to evaluate a bound
    // against yet — which is a different thing from a gate DENIAL, where
    // an authenticated agent's request was evaluated and refused. That
    // distinction is why the gate's own "a denial is a 200" rule (below)
    // is untouched: this 402 branch runs before any agent identity
    // exists, so it can never be confused with a bound the gate checked.
    let priceHintPaise: number | undefined;
    try {
      const maybeBody = await req.clone().json();
      const variantId = typeof maybeBody?.variantId === "string" ? maybeBody.variantId : undefined;
      if (variantId) {
        const [variant] = await db.select({ pricePaise: schema.productVariants.pricePaise }).from(schema.productVariants).where(eq(schema.productVariants.id, variantId));
        // Already public on the storefront and in the manifest — naming
        // it here in a 402 challenge is not a new disclosure.
        priceHintPaise = variant?.pricePaise;
      }
    } catch {
      // A malformed or absent body just means no price hint — the
      // challenge itself doesn't depend on a parseable body.
    }

    return NextResponse.json(
      {
        error: "payment_required",
        message: "Authentication is required before a purchase can be attempted. This is a challenge, not a denial — no agent identity exists yet to evaluate.",
        authenticationScheme: "bearer",
        authenticationNote: "Present a valid agent API key as \"Authorization: Bearer <key>\". Keys are issued by the merchant, or via self-registration where the merchant has opened it.",
        discoveryDocument: `${req.nextUrl.origin}/.well-known/agent-commerce.json`,
        ...(priceHintPaise !== undefined && { pricePaise: priceHintPaise }),
      },
      { status: 402 },
    );
  }

  const rateLimit = await checkRateLimit(`agent-purchase:${agent.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
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

  const { variantId, quantity, idempotencyKey, holdOnly, checkoutMandateJwt } = parsed.data;
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

  // Layer 15-1: capability, model armor, mandate verification, and the
  // gate's own steps all share one trace — the waterfall on
  // /dashboard/explain reads them back as one decision's timeline, not
  // several unrelated ones.
  return withMoneyPathSpan("agent_purchase_request", async () => {
    const hasCapability = await withSpan("capability_check", { "thirdman.capability": "purchase:create" }, () =>
      requireCapability(agent, "purchase:create"),
    );
    if (!hasCapability) {
      return NextResponse.json(
        { error: "This agent does not hold the purchase:create capability." },
        { status: 403 },
      );
    }

    if (!variantId) {
      // Layer 19: the v1 amountPaise+context path is the one place an
      // agent's own free text reaches a money action (variantId's
      // context above is server-generated, nothing to scan). Armor may
      // only block, never approve — a flagged context denies before the
      // gate ever runs, same "deny before checkBounds" shape as mandate
      // verification below. context is guaranteed present by the
      // schema's own refine() when variantId is absent.
      const verdict = await withSpan("model_armor_inbound", { "thirdman.agent_id": agent.id }, () =>
        inspectInbound(context!, { merchantId: agent.merchantId, trustLevel: "untrusted", auditContext: { agentId: agent.id } }),
      );
      if (!verdict.clean) {
        return NextResponse.json(
          { decision: "deny", reason: `Denied — the purchase context failed inbound inspection (rule: ${verdict.rule}).` },
          { status: 200 },
        );
      }
    }

    // Layer 13-3: mandate verification runs BEFORE attemptMoneyAction (and
    // therefore before checkBounds) whenever this agent has opted in — a
    // failing mandate denies without the gate, the risk layer, or a model
    // ever being consulted, per the plan's "the demo this unlocks."
    // Layer 21-7: even when the agent hasn't opted in, a presented mandate
    // is still verified — merchant_agent_terms.mandateRequiredAbovePaise
    // may require one by value alone, and checkBounds needs to know
    // whether one actually verified, not just whether one was presented.
    let mandateVerified = false;
    let checkoutMandateId: string | undefined;
    if (agent.mandateRequired && !checkoutMandateJwt) {
      return NextResponse.json(
        { decision: "deny", reason: "Denied — this agent requires a signed Payment Mandate (checkoutMandateJwt) for every purchase, and none was presented." },
        { status: 200 },
      );
    }
    if (checkoutMandateJwt) {
      const verification = await withSpan("mandate_verification", { "thirdman.agent_id": agent.id }, () =>
        verifyPaymentMandate({
          merchantId: agent.merchantId,
          agentId: agent.id,
          checkoutJwt: checkoutMandateJwt,
          assertedAmountPaise: amountPaise!,
        }),
      );
      if (!verification.ok) {
        return NextResponse.json({ decision: "deny", reason: verification.reason }, { status: 200 });
      }
      mandateVerified = true;
      checkoutMandateId = verification.mandateId;
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
      mandateVerified,
      checkoutMandateId,
    });

    // Layer 21-6: a signed, verifiable receipt over the decision just
    // made — allow, deny, or escalate all get one, on the same terms
    // (see refusal-receipt.ts). undefined on any signing failure, which
    // must never block the real decision above from returning.
    const receipt = await issueRefusalReceipt(agent.merchantId, result);

    return NextResponse.json({ ...result, receipt }, { status: 200 });
  });
}
