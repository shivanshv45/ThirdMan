import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

type AuditActor = (typeof schema.auditActorEnum.enumValues)[number];
type AuditDecision = (typeof schema.auditDecisionEnum.enumValues)[number];

interface LogEntryInput {
  merchantId: string;
  actor: AuditActor;
  event: string;
  decision: AuditDecision;
  /**
   * A sentence explaining WHY, not a status code. This is the field a
   * judge reads. Non-empty is enforced below, not just by the type.
   */
  reason: string;
  /** Which bound was evaluated and its state, e.g. "spend_cap:<id> remaining ₹400 of ₹1000". */
  boundApplied?: string;
  moneyActionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Writes one audit_log row. Used by everything that decides or moves money.
 *
 * Never throws into a money path: a failed write is caught, logged loudly
 * to stderr, and swallowed. Losing an audit row is bad; crashing a payment
 * mid-flight is worse. Callers on a money path must not depend on this
 * function's success to make a correctness decision.
 */
export async function logAuditEntry(input: LogEntryInput): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    // A decision without an articulable reason isn't understood well
    // enough to have been made. This throws, unlike a DB failure below,
    // since it's a programming error to catch in development, not a
    // runtime fault to silently log as "".
    throw new Error(
      `logAuditEntry: reason must be non-empty (event: "${input.event}")`,
    );
  }

  try {
    await db.insert(schema.auditLog).values({
      merchantId: input.merchantId,
      actor: input.actor,
      event: input.event,
      decision: input.decision,
      reason,
      boundApplied: input.boundApplied,
      moneyActionId: input.moneyActionId,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    // Surface loudly, but never propagate. See docstring above.
    console.error(
      `[audit] FAILED to write audit entry for event "${input.event}":`,
      err,
    );
  }
}

/**
 * Recent audit entries for a merchant, newest first, with the linked
 * money action joined. Feeds the merchant dashboard directly.
 */
export async function getRecentAuditEntries(merchantId: string, limit = 50) {
  return db
    .select({
      id: schema.auditLog.id,
      actor: schema.auditLog.actor,
      event: schema.auditLog.event,
      decision: schema.auditLog.decision,
      reason: schema.auditLog.reason,
      boundApplied: schema.auditLog.boundApplied,
      metadata: schema.auditLog.metadata,
      createdAt: schema.auditLog.createdAt,
      moneyAction: {
        id: schema.moneyActions.id,
        type: schema.moneyActions.type,
        amountPaise: schema.moneyActions.amountPaise,
        status: schema.moneyActions.status,
        razorpayEntityId: schema.moneyActions.razorpayEntityId,
      },
    })
    .from(schema.auditLog)
    .leftJoin(
      schema.moneyActions,
      eq(schema.auditLog.moneyActionId, schema.moneyActions.id),
    )
    .where(eq(schema.auditLog.merchantId, merchantId))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(limit);
}
