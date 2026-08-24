import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueRefund } from "@/lib/gate";
import { logAuditEntry } from "@/lib/audit";

/**
 * The escrow demo's bound (Layer 4-5): a hold that is never resolved is
 * money in limbo. sweepExpiredHolds auto-refunds anything past its
 * expiresAt — deterministic code, not a model decision, same standard as
 * every other bound in this codebase (spend caps, stock). Called from
 * the dashboard's escrow view on load (a real merchant checks their
 * dashboard regularly) rather than a background cron this deployment
 * doesn't run, but the function itself has no UI dependency and could be
 * wired to a scheduled job without changing its contract.
 */
export async function sweepExpiredHolds(merchantId: string): Promise<number> {
  const expired = await db
    .select()
    .from(schema.escrowHolds)
    .where(and(eq(schema.escrowHolds.merchantId, merchantId), eq(schema.escrowHolds.outcome, "held"), lt(schema.escrowHolds.expiresAt, new Date())));

  let sweptCount = 0;
  for (const hold of expired) {
    const result = await issueRefund(merchantId, hold.moneyActionId);
    if (result.decision !== "allow") {
      // A refund can genuinely fail (Razorpay down, credentials
      // disconnected) — leave the hold as "held" so the next sweep
      // retries it, rather than marking it resolved when it wasn't.
      console.warn(`[escrow] auto-refund failed for hold ${hold.id}: ${result.reason}`);
      continue;
    }

    await db
      .update(schema.escrowHolds)
      .set({ outcome: "expired_refunded", resolvedAt: new Date() })
      .where(eq(schema.escrowHolds.id, hold.id));

    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "escrow_hold_expired",
      decision: "n/a",
      reason: `Hold ${hold.id} expired unresolved after its deadline and was auto-refunded — a hold left indefinitely is money in limbo, so this codebase never lets one sit past its expiry.`,
      moneyActionId: hold.moneyActionId,
    });

    sweptCount += 1;
  }

  return sweptCount;
}
