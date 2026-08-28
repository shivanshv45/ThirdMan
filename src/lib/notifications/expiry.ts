import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { resolveEscalation } from "@/lib/gate";
import { logAuditEntry } from "@/lib/audit";

/**
 * Auto-resolves any escalation still pending past its expiresAt
 * (Layer 11-7, gate.ts's ESCALATION_EXPIRY_HOURS). This closes a real
 * gap: before this, a pending escalation nobody looked at sat forever —
 * no different from an escrow hold that would never auto-refund if
 * nobody opened /dashboard/escrow.
 *
 * Deliberately reuses gate.ts's resolveEscalation(..., "rejected")
 * rather than writing a second release path — that function already
 * releases reserved budget, stock, and offer/cart items atomically and
 * writes the audit entry. Duplicating that logic here is exactly the
 * mistake plans/layer-11-notifications-and-token-rewards.md's L11-7
 * warns against: getting a second release path wrong leaks spend-cap
 * budget permanently, the worst class of bug in this codebase.
 *
 * Fails closed: timing out DENIES, never auto-approves. Silence from a
 * merchant is not consent.
 */
export async function expirePendingEscalations(limit = 100): Promise<{ expired: number }> {
  const due = await db
    .select({ id: schema.escalations.id, moneyActionId: schema.escalations.moneyActionId })
    .from(schema.escalations)
    .where(and(eq(schema.escalations.outcome, "pending"), lte(schema.escalations.expiresAt, new Date())))
    .limit(limit);

  let expired = 0;
  for (const row of due) {
    const [moneyAction] = await db.select({ merchantId: schema.moneyActions.merchantId }).from(schema.moneyActions).where(eq(schema.moneyActions.id, row.moneyActionId));
    if (!moneyAction) continue;

    try {
      await resolveEscalation(moneyAction.merchantId, row.id, "rejected");
      // resolveEscalation already writes an "escalation_resolved" audit
      // entry naming the merchant rejection reason. Add a second entry
      // specifically naming the TIMEOUT as the trigger — a merchant
      // reading their audit trail should be able to tell "I rejected
      // this" apart from "nobody answered in time," even though the
      // money outcome (denied, budget released) is identical either way.
      await logAuditEntry({
        merchantId: moneyAction.merchantId,
        actor: "system",
        event: "escalation_expired",
        decision: "deny",
        reason: `Escalation ${row.id.slice(0, 8)} auto-denied — no merchant response within the review window. Reserved budget released.`,
        boundApplied: `escalation_expiry_hours`,
        metadata: { escalationId: row.id },
      });
      expired += 1;
    } catch (err) {
      // Already resolved by a merchant between the query above and
      // this call — a benign race, not a failure. Anything else is
      // logged loudly but doesn't stop the rest of the batch.
      console.warn(`[notifications/expiry] failed to expire escalation ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return { expired };
}
