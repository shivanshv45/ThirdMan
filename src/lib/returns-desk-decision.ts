import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueRefund } from "@/lib/gate";
import { logAuditEntry } from "@/lib/audit";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { formatPaise } from "@/lib/money";

/**
 * Layer 22 — the merchant's decision, and the refund (plans/layer-22
 * L22-5). Deliberately a SEPARATE module from returns-desk.ts: that
 * module holds the model conversation and must never import
 * gate.ts's issueRefund, so the structural proof
 * (returns-desk.isolation.test.ts) that no model-reachable path can
 * issue a refund stays true by construction, not by convention. This
 * file is reachable only from a merchant-actor dashboard action.
 */

export async function approveReturnRequest(
  merchantId: string,
  returnRequestId: string,
  amountPaise?: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, returnRequestId));
  if (!request || request.merchantId !== merchantId) {
    return { ok: false, reason: "Return request not found for this merchant." };
  }
  if (request.status !== "awaiting_merchant") {
    return { ok: false, reason: `This request is no longer awaiting a decision (status: "${request.status}").` };
  }

  const refundAmount = amountPaise ?? request.refundableAmountPaise;
  if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > request.refundableAmountPaise) {
    return { ok: false, reason: `Refund amount must be a positive integer no greater than ${formatPaise(request.refundableAmountPaise)}.` };
  }

  const result = await issueRefund(merchantId, request.moneyActionId, refundAmount);
  if (result.decision !== "allow") {
    return { ok: false, reason: result.reason };
  }

  await db
    .update(schema.returnRequests)
    .set({ status: "refunded", approvedAmountPaise: refundAmount, resolutionReason: "Approved by the merchant.", resolvedAt: new Date() })
    .where(eq(schema.returnRequests.id, returnRequestId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "return_request_approved",
    decision: "allow",
    reason: `Return request ${returnRequestId.slice(0, 8)} approved — ${formatPaise(refundAmount)} refunded.`,
    moneyActionId: request.moneyActionId,
    metadata: { returnRequestId },
  });

  await notifyRequester(request, `Your return request has been approved — ${formatPaise(refundAmount)} is being refunded to your original payment method.`);

  return { ok: true };
}

export async function rejectReturnRequest(merchantId: string, returnRequestId: string, reason: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, returnRequestId));
  if (!request || request.merchantId !== merchantId) {
    return { ok: false, reason: "Return request not found for this merchant." };
  }
  if (request.status !== "awaiting_merchant") {
    return { ok: false, reason: `This request is no longer awaiting a decision (status: "${request.status}").` };
  }

  const trimmedReason = reason.trim() || "Rejected by the merchant.";

  await db
    .update(schema.returnRequests)
    .set({ status: "rejected", resolutionReason: trimmedReason, resolvedAt: new Date() })
    .where(eq(schema.returnRequests.id, returnRequestId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "return_request_rejected",
    decision: "deny",
    reason: `Return request ${returnRequestId.slice(0, 8)} rejected — ${trimmedReason}`,
    moneyActionId: request.moneyActionId,
    metadata: { returnRequestId },
  });

  await notifyRequester(request, `Your return request was not approved. ${trimmedReason}`);

  return { ok: true };
}

/**
 * Deterministic content only — amount and identifiers interpolated by
 * code, exactly as deliverRecoveryLink already does for recovery mail,
 * because a model must never produce a number or a URL in outgoing
 * customer mail. A requesting agent (no customer_contacts row) has no
 * notification channel here, matching every other agent-facing surface
 * — an agent learns the outcome by polling the request id instead.
 */
async function notifyRequester(request: typeof schema.returnRequests.$inferSelect, bodyText: string): Promise<void> {
  if (!request.requesterContactId) return;
  const [contact] = await db.select().from(schema.customerContacts).where(eq(schema.customerContacts.id, request.requesterContactId));
  if (!contact) return;

  await enqueueNotification({
    merchantId: request.merchantId,
    recipientKind: "customer",
    contact,
    notificationType: "return_request_resolved",
    subject: "Update on your return request",
    bodyText,
    relatedEntityId: request.id,
  });
}
