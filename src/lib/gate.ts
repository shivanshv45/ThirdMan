import { and, eq, lte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { createOrder, RazorpayCallError } from "@/lib/razorpay";
import { computeRiskSignals, assessRisk } from "@/lib/risk";

/**
 * The only path to a money action in this codebase. Every feature layer
 * built on top of this (checkout, negotiation, upsell, payouts, recovery)
 * must call attemptMoneyAction instead of reaching razorpay.ts directly.
 * See ARCHITECTURE.md, "The gate contract."
 *
 * Every check here is deterministic. No model is consulted for any
 * bound, cap, or arithmetic decision. See CLAUDE.md.
 */

export type GateDecision = "allow" | "deny" | "escalate";

export interface MoneyActionRequest {
  agentId: string;
  merchantId: string;
  type: (typeof schema.moneyActionTypeEnum.enumValues)[number];
  amountPaise: number;
  /** What is being bought, for the audit trail and the risk-assessment layer. */
  context: string;
  /** Agents retry. A repeat with the same key returns the original outcome instead of reserving budget twice. */
  idempotencyKey?: string;
}

export interface GateResult {
  decision: GateDecision;
  reason: string;
  moneyActionId?: string;
  /** Only present on decision: "allow" with a successfully executed action. */
  razorpayOrderId?: string;
}

interface BoundCheckFailure {
  reason: string;
  boundApplied: string;
}

/**
 * The five deterministic checks, in order, short-circuiting on the
 * first failure. Returns null when every check passes.
 */
async function checkBounds(
  request: MoneyActionRequest,
): Promise<BoundCheckFailure | null> {
  if (!Number.isInteger(request.amountPaise) || request.amountPaise <= 0) {
    return {
      reason: `Denied — amount ${request.amountPaise} is not a positive integer number of paise.`,
      boundApplied: "amount_validity",
    };
  }

  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, request.agentId));

  if (!agent) {
    return {
      reason: `Denied — no agent found with id ${request.agentId}.`,
      boundApplied: "agent_exists",
    };
  }

  if (agent.status !== "active") {
    return {
      reason: `Denied — agent "${agent.name}" is ${agent.status}, not active. Revoked agents can never transact.`,
      boundApplied: `agent_status:${agent.id}`,
    };
  }

  const [cap] = await db
    .select()
    .from(schema.spendCaps)
    .where(eq(schema.spendCaps.agentId, request.agentId))
    .orderBy(sql`${schema.spendCaps.createdAt} desc`)
    .limit(1);

  if (!cap) {
    return {
      reason: `Denied — agent "${agent.name}" has no spend cap. Absence of a bound is not permission.`,
      boundApplied: "spend_cap_exists",
    };
  }

  if (cap.status !== "active") {
    return {
      reason: `Denied — spend cap ${cap.id} is ${cap.status}, not active.`,
      boundApplied: `spend_cap_status:${cap.id}`,
    };
  }

  const now = new Date();
  if (now < cap.windowStart || now > cap.windowEnd) {
    // Mark it expired so future checks can short-circuit on cap.status.
    await db
      .update(schema.spendCaps)
      .set({ status: "expired" })
      .where(eq(schema.spendCaps.id, cap.id));

    return {
      reason: `Denied — spend cap ${cap.id}'s window (${cap.windowStart.toISOString()} to ${cap.windowEnd.toISOString()}) has lapsed. Marked expired.`,
      boundApplied: `spend_cap_window:${cap.id}`,
    };
  }

  if (request.amountPaise > cap.perTransactionMaxPaise) {
    return {
      reason: `Denied — ₹${(request.amountPaise / 100).toFixed(2)} exceeds this agent's per-transaction limit of ₹${(cap.perTransactionMaxPaise / 100).toFixed(2)}, even though the window total may allow it.`,
      boundApplied: `per_transaction_max:${cap.id}`,
    };
  }

  const remainingPaise = cap.capPaise - cap.spentPaise;
  if (request.amountPaise > remainingPaise) {
    return {
      reason: `Denied — ₹${(request.amountPaise / 100).toFixed(2)} exceeds the ₹${(remainingPaise / 100).toFixed(2)} remaining in this agent's ₹${(cap.capPaise / 100).toFixed(2)} cap (₹${(cap.spentPaise / 100).toFixed(2)} already spent this window).`,
      boundApplied: `spend_cap_balance:${cap.id}`,
    };
  }

  return null;
}

/**
 * Atomically reserves amountPaise against the agent's active spend cap.
 * The WHERE clause re-verifies the balance in the same statement as the
 * increment, so two concurrent requests racing for the same headroom
 * leave exactly one UPDATE affecting a row and the other affecting zero.
 * That is what makes this safe under concurrency without table locking.
 */
async function reserveBudget(
  capId: string,
  amountPaise: number,
): Promise<boolean> {
  const result = await db
    .update(schema.spendCaps)
    .set({ spentPaise: sql`${schema.spendCaps.spentPaise} + ${amountPaise}` })
    .where(
      and(
        eq(schema.spendCaps.id, capId),
        eq(schema.spendCaps.status, "active"),
        lte(
          sql`${schema.spendCaps.spentPaise} + ${amountPaise}`,
          schema.spendCaps.capPaise,
        ),
      ),
    )
    .returning({ id: schema.spendCaps.id });

  return result.length > 0;
}

/** Gives budget back to the cap. Called when a reserved money action fails to execute. */
async function releaseBudget(capId: string, amountPaise: number): Promise<void> {
  await db
    .update(schema.spendCaps)
    .set({ spentPaise: sql`greatest(${schema.spendCaps.spentPaise} - ${amountPaise}, 0)` })
    .where(eq(schema.spendCaps.id, capId));
}

/**
 * Inserts the money_actions row after budget is already reserved. If two
 * concurrent requests share the same idempotency key, both can pass the
 * earlier idempotency check (before either has a row yet) and both reach
 * here — the unique index on (agentId, idempotencyKey) lets exactly one
 * insert win. The loser releases its own reservation and replays the
 * winner's row instead of creating a duplicate.
 */
async function insertMoneyActionOrReplay(
  capId: string,
  values: typeof schema.moneyActions.$inferInsert,
): Promise<{ action: typeof schema.moneyActions.$inferSelect; wasReplay: boolean }> {
  try {
    const [action] = await db.insert(schema.moneyActions).values(values).returning();
    return { action, wasReplay: false };
  } catch (err) {
    // drizzle wraps the raw postgres error, putting the actual PostgresError
    // (with its .code) on err.cause rather than on err itself.
    const pgCode = (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode !== "23505" || !values.idempotencyKey) throw err;

    await releaseBudget(capId, values.amountPaise);
    const [existing] = await db
      .select()
      .from(schema.moneyActions)
      .where(
        and(
          eq(schema.moneyActions.agentId, values.agentId!),
          eq(schema.moneyActions.idempotencyKey, values.idempotencyKey),
        ),
      );
    if (!existing) throw err;
    return { action: existing, wasReplay: true };
  }
}

interface ExecuteAndSettleInput {
  merchantId: string;
  moneyActionId: string;
  capId: string;
  amountPaise: number;
  context: string;
  agentId: string;
  actor: (typeof schema.auditActorEnum.enumValues)[number];
  allowReasonPrefix: string;
}

/**
 * Executes a reserved money action against Razorpay and settles it:
 * commits on success, releases the reservation on failure. Shared by
 * both attemptMoneyAction's direct-allow path and resolveEscalation's
 * approve path, since both start from budget already reserved.
 */
async function executeAndSettle(input: ExecuteAndSettleInput): Promise<GateResult> {
  try {
    const order = await createOrder({
      amountPaise: input.amountPaise,
      receipt: input.moneyActionId,
      notes: { agentId: input.agentId, context: input.context },
    });

    await db
      .update(schema.moneyActions)
      .set({ status: "executed", razorpayEntityId: order.id })
      .where(eq(schema.moneyActions.id, input.moneyActionId));

    const reason = `${input.allowReasonPrefix} and executed successfully.`;
    await logAuditEntry({
      merchantId: input.merchantId,
      actor: input.actor,
      event: "money_action_executed",
      decision: "allow",
      reason,
      boundApplied: `spend_cap_balance:${input.capId}`,
      moneyActionId: input.moneyActionId,
      metadata: { razorpayOrderId: order.id },
    });

    return { decision: "allow", reason, moneyActionId: input.moneyActionId, razorpayOrderId: order.id };
  } catch (executionErr) {
    // A failed payment must not consume the agent's cap.
    await releaseBudget(input.capId, input.amountPaise);

    await db
      .update(schema.moneyActions)
      .set({ status: "failed" })
      .where(eq(schema.moneyActions.id, input.moneyActionId));

    const isRazorpayDecline = executionErr instanceof RazorpayCallError && executionErr.isRazorpayError;
    const reason = isRazorpayDecline
      ? `Execution failed — Razorpay rejected the order (${(executionErr as RazorpayCallError).razorpayCode}): ${executionErr instanceof Error ? executionErr.message : String(executionErr)}. Reserved budget released back to the cap.`
      : `Execution failed — ${executionErr instanceof Error ? executionErr.message : String(executionErr)}. Reserved budget released back to the cap.`;

    await logAuditEntry({
      merchantId: input.merchantId,
      actor: "system",
      event: "money_action_execution_failed",
      decision: "deny",
      reason,
      boundApplied: `spend_cap_balance:${input.capId}`,
      moneyActionId: input.moneyActionId,
    });

    return { decision: "deny", reason, moneyActionId: input.moneyActionId };
  }
}

/**
 * The single entry point for every money action. Runs the deterministic
 * checks, reserves budget atomically, executes against Razorpay, and
 * commits or releases the reservation, then always logs allow or deny.
 * Fails closed: any unexpected error results in a deny, never an allow.
 */
/** Reconstructs a GateResult from a previously-stored money_actions row, for idempotent replay. */
function resultFromExistingAction(
  action: typeof schema.moneyActions.$inferSelect,
): GateResult {
  const decision: GateDecision =
    action.status === "pending_escalation" ? "escalate" : action.status === "denied" || action.status === "failed" ? "deny" : "allow";

  return {
    decision,
    reason: `Idempotent replay — an action with this key already ${action.status === "executed" ? "executed" : action.status === "pending_escalation" ? "escalated" : "resolved"} (money_action ${action.id}). Returning the original outcome instead of reserving budget twice.`,
    moneyActionId: action.id,
    razorpayOrderId: action.razorpayEntityId ?? undefined,
  };
}

export async function attemptMoneyAction(
  request: MoneyActionRequest,
): Promise<GateResult> {
  try {
    if (request.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(schema.moneyActions)
        .where(
          and(
            eq(schema.moneyActions.agentId, request.agentId),
            eq(schema.moneyActions.idempotencyKey, request.idempotencyKey),
          ),
        );
      if (existing) {
        return resultFromExistingAction(existing);
      }
    }

    const failure = await checkBounds(request);
    if (failure) {
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "agent",
        event: `money_action_attempt:${request.type}`,
        decision: "deny",
        reason: failure.reason,
        boundApplied: failure.boundApplied,
        metadata: { agentId: request.agentId, amountPaise: request.amountPaise, context: request.context },
      });
      return { decision: "deny", reason: failure.reason };
    }

    // Re-fetch rather than thread the cap through from checkBounds, so
    // the reservation's WHERE clause is the sole source of truth on balance.
    const [cap] = await db
      .select()
      .from(schema.spendCaps)
      .where(eq(schema.spendCaps.agentId, request.agentId))
      .orderBy(sql`${schema.spendCaps.createdAt} desc`)
      .limit(1);

    if (!cap) {
      // checkBounds already verified this exists, so getting here means
      // the cap was deleted between the check and now.
      const reason = "Denied — spend cap disappeared between check and reservation.";
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "agent",
        event: `money_action_attempt:${request.type}`,
        decision: "deny",
        reason,
        metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
      });
      return { decision: "deny", reason };
    }

    const reserved = await reserveBudget(cap.id, request.amountPaise);
    if (!reserved) {
      const reason = `Denied — another request consumed the remaining budget on spend cap ${cap.id} between check and reservation.`;
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "agent",
        event: `money_action_attempt:${request.type}`,
        decision: "deny",
        reason,
        boundApplied: `spend_cap_balance:${cap.id}`,
        metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
      });
      return { decision: "deny", reason };
    }

    // Budget is reserved. The risk layer runs next: it can only downgrade
    // this to pending_escalation, never turn a passed bound check into a
    // deny, since attemptMoneyAction only reaches here after every
    // deterministic check has already passed.
    const signals = await computeRiskSignals(request.agentId, request.amountPaise, cap);
    const risk = await assessRisk(signals, request.context);

    if (risk.decision === "escalate") {
      const { action: moneyAction, wasReplay } = await insertMoneyActionOrReplay(cap.id, {
        merchantId: request.merchantId,
        agentId: request.agentId,
        type: request.type,
        amountPaise: request.amountPaise,
        status: "pending_escalation",
        idempotencyKey: request.idempotencyKey,
      });

      if (wasReplay) return resultFromExistingAction(moneyAction);

      await db.insert(schema.escalations).values({
        moneyActionId: moneyAction.id,
        spendCapId: cap.id,
        riskReason: risk.reason,
      });

      const reason = `Escalated — ${risk.reason} (assessed by ${risk.source}). Budget reserved and held pending merchant review.`;
      await logAuditEntry({
        merchantId: request.merchantId,
        actor: "system",
        event: `money_action_attempt:${request.type}`,
        decision: "escalate",
        reason,
        boundApplied: `spend_cap_balance:${cap.id}`,
        moneyActionId: moneyAction.id,
        metadata: { riskSource: risk.source, signals },
      });

      return { decision: "escalate", reason, moneyActionId: moneyAction.id };
    }

    // Record the money_actions row before executing, so a crash mid-call
    // still leaves a traceable "allowed" row rather than nothing at all.
    const { action: moneyAction, wasReplay } = await insertMoneyActionOrReplay(cap.id, {
      merchantId: request.merchantId,
      agentId: request.agentId,
      type: request.type,
      amountPaise: request.amountPaise,
      status: "allowed",
      idempotencyKey: request.idempotencyKey,
    });

    if (wasReplay) return resultFromExistingAction(moneyAction);

    return executeAndSettle({
      merchantId: request.merchantId,
      moneyActionId: moneyAction.id,
      capId: cap.id,
      amountPaise: request.amountPaise,
      context: request.context,
      agentId: request.agentId,
      actor: "agent",
      allowReasonPrefix: `Allowed — ₹${(request.amountPaise / 100).toFixed(2)} for "${request.context}" is within this agent's remaining cap`,
    });
  } catch (unexpectedErr) {
    // Fail closed: anything not already handled above still denies.
    const reason = `Denied — the gate could not evaluate this request: ${unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr)}.`;
    await logAuditEntry({
      merchantId: request.merchantId,
      actor: "system",
      event: `money_action_gate_error:${request.type}`,
      decision: "deny",
      reason,
      metadata: { agentId: request.agentId, amountPaise: request.amountPaise },
    });
    return { decision: "deny", reason };
  }
}

/**
 * A merchant resolving a pending escalation. Approving executes the
 * held reservation exactly like a direct allow. Rejecting releases the
 * reservation without ever calling Razorpay. Both outcomes write an
 * audit entry, and both write to the escalations table so the dashboard
 * reflects a settled state.
 */
export async function resolveEscalation(
  merchantId: string,
  escalationId: string,
  outcome: "approved" | "rejected",
): Promise<GateResult> {
  const [escalation] = await db
    .select()
    .from(schema.escalations)
    .where(eq(schema.escalations.id, escalationId));

  if (!escalation) {
    throw new Error(`No escalation found with id ${escalationId}`);
  }

  const [moneyAction] = await db
    .select()
    .from(schema.moneyActions)
    .where(eq(schema.moneyActions.id, escalation.moneyActionId));

  if (!moneyAction) {
    throw new Error(`Escalation ${escalationId} references a missing money action`);
  }

  // An escalation belongs to whichever merchant its money action belongs
  // to. Reject up front rather than let a merchant resolve another
  // merchant's escalation by guessing its id.
  if (moneyAction.merchantId !== merchantId) {
    throw new Error(`Escalation ${escalationId} does not belong to this merchant`);
  }

  // Conditional on outcome still being "pending" in the same statement,
  // so two concurrent resolutions of the same escalation can't both
  // proceed past this point. Whichever loses affects zero rows.
  const claimed = await db
    .update(schema.escalations)
    .set({ outcome, resolvedAt: new Date() })
    .where(and(eq(schema.escalations.id, escalationId), eq(schema.escalations.outcome, "pending")))
    .returning({ id: schema.escalations.id });

  if (claimed.length === 0) {
    throw new Error(`Escalation ${escalationId} was already resolved`);
  }

  if (outcome === "rejected") {
    await releaseBudget(escalation.spendCapId, moneyAction.amountPaise);
    await db
      .update(schema.moneyActions)
      .set({ status: "failed" })
      .where(eq(schema.moneyActions.id, moneyAction.id));

    const reason = `Rejected by merchant — ${escalation.riskReason} Reserved budget released back to the cap.`;
    await logAuditEntry({
      merchantId: moneyAction.merchantId,
      actor: "merchant",
      event: "escalation_resolved",
      decision: "deny",
      reason,
      boundApplied: `spend_cap_balance:${escalation.spendCapId}`,
      moneyActionId: moneyAction.id,
    });

    return { decision: "deny", reason, moneyActionId: moneyAction.id };
  }

  return executeAndSettle({
    merchantId: moneyAction.merchantId,
    moneyActionId: moneyAction.id,
    capId: escalation.spendCapId,
    amountPaise: moneyAction.amountPaise,
    context: "merchant-approved escalation",
    agentId: moneyAction.agentId ?? "",
    actor: "merchant",
    allowReasonPrefix: `Approved by merchant — ₹${(moneyAction.amountPaise / 100).toFixed(2)} previously escalated (${escalation.riskReason})`,
  });
}
