import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { inspectInbound } from "@/lib/model-armor";
import { completeStructured } from "@/lib/llm";
import { formatPaise } from "@/lib/money";
import { normalizeEmail } from "@/lib/contacts";
import { z } from "zod";

/**
 * Layer 22 — the returns desk (plans/layer-22-returns-desk.md).
 *
 * The governing rule: the model decides whether a request is worth the
 * merchant's attention. Code decides that only the merchant can approve
 * it, and code computes every rupee.
 *
 * Structural guarantee this module exists to make true, not just state:
 * there is no function in this file, or reachable from it, that issues
 * a refund. issueRefund lives in gate.ts and is called only from the
 * merchant-actor dashboard action (returns/actions.ts) — never from
 * here. See returns-desk.isolation.test.ts for the static proof.
 */

export const RETURN_REQUEST_DEFAULT_EXPIRY_HOURS = 72;

// ---------------------------------------------------------------------
// L22-2 — the deterministic eligibility gate, which runs before the
// model is consulted at all. Every check here has a factual answer;
// none of them is a judgement call.
// ---------------------------------------------------------------------

export type EligibilityFailure =
  | "not_found"
  | "wrong_requester"
  | "not_captured"
  | "outside_window"
  | "already_refunded"
  | "already_open";

export interface EligibilityResult {
  eligible: boolean;
  failure?: EligibilityFailure;
  reason: string;
  refundableAmountPaise: number;
}

export type Requester = { contactId: string } | { agentId: string };

/**
 * Runs the full eligibility check, in the exact order the plan
 * specifies — id-enumeration and captured-status checks first (the
 * cheapest, least ambiguous facts), the return window and duplicate
 * check last. Any failure ends the request deterministically; nothing
 * here ever consults a model.
 */
export async function checkReturnEligibility(merchantId: string, moneyActionId: string, requester: Requester): Promise<EligibilityResult> {
  // Scoped by merchant in the WHERE clause itself, not checked after the
  // fact — the same id-enumeration discipline isolation.test.ts already
  // exercises elsewhere: a cross-merchant id must never even be fetched.
  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(and(eq(schema.moneyActions.id, moneyActionId), eq(schema.moneyActions.merchantId, merchantId)));

  if (!moneyAction) {
    return { eligible: false, failure: "not_found", reason: "No purchase found with that id for this merchant.", refundableAmountPaise: 0 };
  }

  // A human buyer's purchase is reachable via money_actions.cartId ->
  // cart_purchases.conversationId -> conversations.customerContactId —
  // there is no direct customerContactId column on money_actions itself.
  // An agent's purchase is identified directly by money_actions.agentId.
  const belongsToRequester =
    "contactId" in requester
      ? moneyAction.cartId
        ? await db
            .select({ id: schema.conversations.id })
            .from(schema.cartPurchases)
            .innerJoin(schema.conversations, eq(schema.conversations.id, schema.cartPurchases.conversationId))
            .where(and(eq(schema.cartPurchases.id, moneyAction.cartId), eq(schema.conversations.customerContactId, requester.contactId)))
            .then((rows) => rows.length > 0)
        : false
      : moneyAction.agentId === requester.agentId;

  if (!belongsToRequester) {
    return { eligible: false, failure: "wrong_requester", reason: "This purchase doesn't belong to you.", refundableAmountPaise: 0 };
  }

  if ((moneyAction.status !== "captured" && moneyAction.status !== "held") || !moneyAction.razorpayPaymentId) {
    return {
      eligible: false,
      failure: "not_captured",
      reason: `This purchase has no captured payment to refund (status "${moneyAction.status}").`,
      refundableAmountPaise: 0,
    };
  }

  const [policy] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId));
  if (policy?.returnsAccepted && policy.returnWindowDays !== null) {
    const deadline = new Date(moneyAction.createdAt.getTime() + policy.returnWindowDays * 24 * 60 * 60 * 1000);
    if (new Date() > deadline) {
      return {
        eligible: false,
        failure: "outside_window",
        reason: `This purchase was made more than ${policy.returnWindowDays} day(s) ago, outside this merchant's published return window.`,
        refundableAmountPaise: 0,
      };
    }
  }
  // No published window (policy absent, or returnsAccepted with no
  // returnWindowDays set) is forwarded to the merchant, never denied —
  // the honest behaviour when a fact hasn't been published is to let a
  // human decide, not to invent a default (per the plan's L22-2).

  // A full refund transitions money_actions.status to "failed" (gate.ts's
  // issueRefund), which the not_captured check above already denies —
  // "already fully refunded, whether through this desk or directly from
  // the dashboard" and "no captured payment" are the same fact. What
  // that check can't see is a PARTIAL refund already issued through
  // this desk (status stays "captured"), so that's checked separately
  // here against return_requests itself.
  const alreadyRefunded = await db
    .select({ id: schema.returnRequests.id })
    .from(schema.returnRequests)
    .where(and(eq(schema.returnRequests.moneyActionId, moneyActionId), eq(schema.returnRequests.status, "refunded")));
  if (alreadyRefunded.length > 0) {
    return { eligible: false, failure: "already_refunded", reason: "This purchase has already been refunded.", refundableAmountPaise: 0 };
  }

  const openRequest = await db
    .select({ id: schema.returnRequests.id })
    .from(schema.returnRequests)
    .where(and(eq(schema.returnRequests.moneyActionId, moneyActionId), eq(schema.returnRequests.status, "awaiting_merchant")));
  if (openRequest.length > 0) {
    return { eligible: false, failure: "already_open", reason: "A return request for this purchase is already awaiting the merchant's decision.", refundableAmountPaise: 0 };
  }

  return { eligible: true, reason: "Eligible for a return request.", refundableAmountPaise: moneyAction.amountPaise };
}

// A merchant-configured return-request review window doesn't exist yet
// (merchant_policies.returnWindowDays governs the BUYER's window to
// request a return, a different thing) — every request gets the same
// default review window, mirroring escrow's ESCROW_HOLD_EXPIRY_HOURS
// shape rather than escalations' merchant-configurable one.
/**
 * A human buyer has no account (Layer 18's own limitation, applied here
 * the same honest way) — the one credential a storefront visitor can
 * prove is the email already on file for that purchase's conversation
 * (set via chat.ts's provide_contact flow). A purchase whose
 * conversation never captured an email has no reachable buyer identity
 * at all; that's a real, honest limitation, not a bug to route around
 * with a weaker check.
 */
export async function resolveContactRequesterForMoneyAction(merchantId: string, moneyActionId: string, statedEmail: string): Promise<{ contactId: string } | null> {
  const normalized = normalizeEmail(statedEmail);
  if (!normalized) return null;

  const [moneyAction] = await db.select().from(schema.moneyActions).where(and(eq(schema.moneyActions.id, moneyActionId), eq(schema.moneyActions.merchantId, merchantId)));
  if (!moneyAction?.cartId) return null;

  const [row] = await db
    .select({ contactId: schema.customerContacts.id, address: schema.customerContacts.address })
    .from(schema.cartPurchases)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.cartPurchases.conversationId))
    .innerJoin(schema.customerContacts, eq(schema.customerContacts.id, schema.conversations.customerContactId))
    .where(eq(schema.cartPurchases.id, moneyAction.cartId));

  if (!row || row.address !== normalized) return null;
  return { contactId: row.contactId };
}

function nextExpiry(): Date {
  return new Date(Date.now() + RETURN_REQUEST_DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);
}

/**
 * Opens a request, or refuses deterministically, before any model call.
 * A refusal here writes no return_requests row and never reaches the
 * merchant's queue — the buyer gets a real, immediate reason instead.
 */
export async function openReturnRequest(
  merchantId: string,
  moneyActionId: string,
  requester: Requester,
  statedReason: string,
): Promise<{ requestId: string; status: "awaiting_merchant" } | { requestId: null; status: "refused"; reason: string }> {
  const eligibility = await checkReturnEligibility(merchantId, moneyActionId, requester);
  if (!eligibility.eligible) {
    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "return_request_refused",
      decision: "deny",
      reason: `Return request refused before reaching the merchant — ${eligibility.reason}`,
      moneyActionId,
      boundApplied: `return_eligibility:${eligibility.failure}`,
    });
    return { requestId: null, status: "refused", reason: eligibility.reason };
  }

  const [row] = await db
    .insert(schema.returnRequests)
    .values({
      merchantId,
      moneyActionId,
      requesterContactId: "contactId" in requester ? requester.contactId : undefined,
      requesterAgentId: "agentId" in requester ? requester.agentId : undefined,
      statedReason,
      refundableAmountPaise: eligibility.refundableAmountPaise,
      expiresAt: nextExpiry(),
    })
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "contactId" in requester ? "customer" : "agent",
    event: "return_request_opened",
    decision: "n/a",
    reason: `Return request opened for a ${formatPaise(eligibility.refundableAmountPaise)} purchase — awaiting the merchant's decision.`,
    moneyActionId,
    metadata: { returnRequestId: row.id },
  });

  return { requestId: row.id, status: "awaiting_merchant" };
}

// ---------------------------------------------------------------------
// L22-3 — the conversation. Reuses model-armor's inbound scan exactly
// as chat.ts does; a return request is free text, from a stranger, that
// a merchant will read and act on, so this pass is not optional.
// ---------------------------------------------------------------------

export async function recordReturnMessage(returnRequestId: string, role: "buyer" | "assistant", content: string): Promise<void> {
  await db.insert(schema.returnRequestMessages).values({ returnRequestId, role, content });
}

export async function getReturnConversation(returnRequestId: string) {
  return db
    .select()
    .from(schema.returnRequestMessages)
    .where(eq(schema.returnRequestMessages.returnRequestId, returnRequestId))
    .orderBy(schema.returnRequestMessages.createdAt);
}

/**
 * One turn of the buyer conversation. The model's only unilateral power
 * is declining to forward a request — it can never approve or escalate
 * an amount. Ambiguity always resolves toward the human: the model is
 * asked to ask a clarifying question rather than guess, and the
 * fallback on any model failure is to keep the request open and
 * awaiting the merchant, never to decline it on the buyer's behalf.
 */
export async function handleReturnDeskTurn(
  merchantId: string,
  returnRequestId: string,
  buyerMessage: string,
): Promise<{ reply: string; declined: boolean }> {
  const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, returnRequestId));
  if (!request || request.merchantId !== merchantId) {
    throw new Error(`No return request ${returnRequestId} found for this merchant`);
  }
  if (request.status !== "awaiting_merchant") {
    return { reply: "This request has already been resolved and is no longer open for conversation.", declined: false };
  }

  await recordReturnMessage(returnRequestId, "buyer", buyerMessage);

  const inboundVerdict = await inspectInbound(buyerMessage, {
    merchantId,
    trustLevel: "untrusted",
    auditContext: { conversationId: returnRequestId },
  });
  if (!inboundVerdict.clean) {
    const reply = "I can't process that message. Please describe your return in plain terms — what you bought, and what's wrong with it.";
    await recordReturnMessage(returnRequestId, "assistant", reply);
    return { reply, declined: false };
  }

  const [policy] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId));
  const history = await getReturnConversation(returnRequestId);
  const historyText = history.map((m) => `${m.role === "buyer" ? "Buyer" : "Assistant"}: ${m.content}`).join("\n");

  const turnSchema = z.object({
    reply: z.string().min(1),
    action: z.enum(["ask_clarifying_question", "decline", "ready_to_escalate"]),
    declineReason: z.string().nullable(),
  });

  let turn: z.infer<typeof turnSchema>;
  try {
    const { data } = await completeStructured({
      systemPrompt: `You are the returns desk for a merchant. Your job is to gather what the merchant needs to decide on a return: what was bought, what's wrong with it, when the buyer noticed, and what outcome they want. Ask a follow-up question when an answer is too vague to act on — a one-line "it's bad, refund me" needs specifics, not an escalation.\n\nYou may DECLINE only when the claim stays incoherent after a real attempt to clarify, or when it plainly falls outside the merchant's published policy: ${policy ? `${policy.returnsAccepted ? `returns accepted within ${policy.returnWindowDays ?? "an unspecified number of"} days` : "this merchant does not accept returns"}` : "no policy is published"}. Otherwise, once you have enough facts, mark ready_to_escalate — you never approve or reject a refund yourself, you only decide whether this is ready for the merchant to see.`,
      prompt: `Conversation so far:\n${historyText}\n\nRespond to the buyer's latest message.`,
      schema: turnSchema,
      schemaDescription: `{"reply": string, "action": "ask_clarifying_question" | "decline" | "ready_to_escalate", "declineReason": string | null}`,
    });
    turn = data;
  } catch (err) {
    console.warn("[returns-desk] conversation turn failed, staying open:", err);
    const reply = "Thanks — I've got that noted. The merchant will review your request shortly.";
    await recordReturnMessage(returnRequestId, "assistant", reply);
    return { reply, declined: false };
  }

  await recordReturnMessage(returnRequestId, "assistant", turn.reply);

  if (turn.action === "decline") {
    const reason = turn.declineReason?.trim() || "The claim could not be resolved into something the merchant can act on.";
    await db
      .update(schema.returnRequests)
      .set({ status: "declined_by_desk", resolutionReason: reason, resolvedAt: new Date() })
      .where(eq(schema.returnRequests.id, returnRequestId));
    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "return_request_declined_by_desk",
      decision: "deny",
      reason: `Returns desk declined to forward request ${returnRequestId.slice(0, 8)} — ${reason}`,
      moneyActionId: request.moneyActionId,
      boundApplied: "return_desk:model_decline",
      metadata: { returnRequestId },
    });
    return { reply: turn.reply, declined: true };
  }

  if (turn.action === "ready_to_escalate") {
    await generateReturnRecommendation(merchantId, returnRequestId);
  }

  return { reply: turn.reply, declined: false };
}

// ---------------------------------------------------------------------
// L22-4 — the recommendation. Drafting only: a candidate until a
// merchant acts on it. A model failure degrades to escalating with no
// recommendation, never to declining and never to approving.
// ---------------------------------------------------------------------

const recommendationSchema = z.object({
  summary: z.string().min(1),
  recommendation: z.enum(["approve", "reject", "needs_merchant_judgement"]),
  reasoning: z.string().min(1),
});

export async function generateReturnRecommendation(merchantId: string, returnRequestId: string): Promise<void> {
  const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, returnRequestId));
  if (!request || request.merchantId !== merchantId) return;

  const [policy] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId));
  const history = await getReturnConversation(returnRequestId);
  const historyText = history.map((m) => `${m.role === "buyer" ? "Buyer" : "Assistant"}: ${m.content}`).join("\n");

  try {
    const { data } = await completeStructured({
      systemPrompt: `You are drafting a recommendation for a merchant deciding a return request. Produce a short factual summary of the claim, name the specific policy clause it does or does not fall under, and give your recommendation with reasoning. This merchant's policy: ${policy ? `${policy.returnsAccepted ? `returns accepted within ${policy.returnWindowDays ?? "an unspecified number of"} days` : "does not accept returns"}` : "no policy published"}. You never state or compute a refund amount — that is handled separately by the merchant's own system.`,
      prompt: `Return conversation:\n${historyText}\n\nStated reason: ${request.statedReason}\n\nProduce your recommendation.`,
      schema: recommendationSchema,
      schemaDescription: `{"summary": string, "recommendation": "approve" | "reject" | "needs_merchant_judgement", "reasoning": string}`,
    });

    await db
      .update(schema.returnRequests)
      .set({ modelSummary: data.summary, modelRecommendation: data.recommendation, modelReasoning: data.reasoning })
      .where(eq(schema.returnRequests.id, returnRequestId));
  } catch (err) {
    // Fail closed toward the human, not away from them: no recommendation
    // is stored, the request stays awaiting_merchant, and the merchant
    // sees the raw conversation and decides without help.
    console.warn("[returns-desk] recommendation generation failed, merchant will see the raw conversation:", err);
  }

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "return_request_escalated",
    decision: "escalate",
    reason: `Return request ${returnRequestId.slice(0, 8)} escalated to the merchant for a decision.`,
    moneyActionId: request.moneyActionId,
    metadata: { returnRequestId },
  });
}

// ---------------------------------------------------------------------
// L22-5 — expiry. A request past its expiresAt resolves as expired, not
// approved. Idempotent under an overlapping sweep, same conditional-
// UPDATE-claim discipline as sweepAbandonedReservations.
// ---------------------------------------------------------------------

export async function sweepExpiredReturnRequests(limit = 100): Promise<{ expired: number }> {
  const due = await db
    .select({ id: schema.returnRequests.id, merchantId: schema.returnRequests.merchantId, moneyActionId: schema.returnRequests.moneyActionId })
    .from(schema.returnRequests)
    .where(and(eq(schema.returnRequests.status, "awaiting_merchant")))
    .limit(limit);

  let expired = 0;
  const now = new Date();
  for (const row of due) {
    const [fresh] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, row.id));
    if (!fresh || fresh.status !== "awaiting_merchant" || fresh.expiresAt > now) continue;

    const claimed = await db
      .update(schema.returnRequests)
      .set({ status: "expired", resolutionReason: "No merchant response within the review window.", resolvedAt: new Date() })
      .where(and(eq(schema.returnRequests.id, row.id), eq(schema.returnRequests.status, "awaiting_merchant")))
      .returning({ id: schema.returnRequests.id });
    if (claimed.length === 0) continue; // Already resolved by a merchant — benign race.

    await logAuditEntry({
      merchantId: row.merchantId,
      actor: "system",
      event: "return_request_expired",
      decision: "deny",
      reason: `Return request ${row.id.slice(0, 8)} auto-expired — no merchant response within the review window. Not refunded.`,
      moneyActionId: row.moneyActionId,
      boundApplied: "return_request_expiry",
      metadata: { returnRequestId: row.id },
    });
    expired += 1;
  }

  return { expired };
}
