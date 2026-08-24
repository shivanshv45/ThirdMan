import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { attemptMoneyAction } from "@/lib/gate";
import { diagnoseFailure, type Diagnosis } from "@/lib/recovery/diagnose";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import {
  chooseStrategy,
  nextAttemptTime,
  shouldAttemptRecovery,
  type PriorAttempt,
} from "@/lib/recovery/policy";

/**
 * Orchestrates recovery for one payment failure. Decides nothing itself —
 * every decision comes from diagnose.ts (what happened) or policy.ts
 * (whether/how to act). This module's only job is to carry those
 * decisions out and record what happened, the same separation gate.ts
 * keeps between checkBounds (decides) and executeAndSettle (carries out).
 */

export interface RecoveryOutcome {
  failureId: string;
  proceeded: boolean;
  strategy?: string;
  /** "pending" (Layer 4-3): a real payment link was created but not yet paid — the payment_link.paid webhook resolves this to "succeeded" later. */
  outcome?: "succeeded" | "failed" | "abandoned" | "pending";
  recoveredPaise: number;
  reason: string;
  stoppingRule?: string;
}

/** Loads a failure and throws unless it belongs to the given merchant — same pattern as requireOwnedAgent in dashboard-mutations.ts. */
async function requireOwnedFailure(merchantId: string, failureId: string) {
  const [failure] = await db
    .select()
    .from(schema.paymentFailures)
    .where(and(eq(schema.paymentFailures.id, failureId), eq(schema.paymentFailures.merchantId, merchantId)));

  if (!failure) throw new Error("Payment failure not found");
  return failure;
}


async function getPriorAttempts(failureId: string): Promise<PriorAttempt[]> {
  const rows = await db
    .select()
    .from(schema.recoveryAttempts)
    .where(eq(schema.recoveryAttempts.paymentFailureId, failureId))
    .orderBy(asc(schema.recoveryAttempts.attemptNumber));

  return rows.map((r) => ({
    attemptNumber: r.attemptNumber,
    outcome: r.outcome,
    createdAt: r.createdAt,
    nextAttemptAt: r.nextAttemptAt,
  }));
}

async function getDiagnosis(
  failure: typeof schema.paymentFailures.$inferSelect,
): Promise<Diagnosis> {
  if (failure.diagnosis) {
    return failure.diagnosis as Diagnosis;
  }

  const diagnosis = await diagnoseFailure(failure);

  await db
    .update(schema.paymentFailures)
    .set({ diagnosis, status: "diagnosed" })
    .where(eq(schema.paymentFailures.id, failure.id));

  await logAuditEntry({
    merchantId: failure.merchantId,
    actor: "system",
    event: "payment_failure_diagnosed",
    decision: "n/a",
    reason: `Diagnosis (${diagnosis.source}): ${diagnosis.rootCause} Category: ${diagnosis.category}. ${diagnosis.recoverable ? "Judged recoverable." : "Judged unrecoverable."}`,
    metadata: { paymentFailureId: failure.id, category: diagnosis.category },
  });

  return diagnosis;
}

/**
 * A stop is recorded as a first-class outcome — not an early return with
 * nothing written — mirroring how a gate denial always writes an
 * audit_log row. The stopped attempts are the evidence the bounds are
 * real.
 */
async function recordStop(
  merchantId: string,
  failureId: string,
  attemptNumber: number,
  decision: { reason: string; stoppingRule?: string },
): Promise<void> {
  await db.insert(schema.recoveryAttempts).values({
    paymentFailureId: failureId,
    attemptNumber,
    strategy: "write_off",
    outcome: "abandoned",
    reason: decision.reason,
    recoveredPaise: 0,
    completedAt: new Date(),
  });

  await db
    .update(schema.paymentFailures)
    .set({ status: "written_off" })
    .where(eq(schema.paymentFailures.id, failureId));

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "recovery_stopped",
    decision: "deny",
    reason: decision.reason,
    boundApplied: decision.stoppingRule,
    metadata: { paymentFailureId: failureId },
  });
}

export async function runRecoveryForFailure(
  merchantId: string,
  failureId: string,
): Promise<RecoveryOutcome> {
  const failure = await requireOwnedFailure(merchantId, failureId);

  if (failure.status === "recovered" || failure.status === "written_off") {
    return {
      failureId,
      proceeded: false,
      recoveredPaise: 0,
      reason: `This failure is already ${failure.status}. No action taken.`,
    };
  }

  const diagnosis = await getDiagnosis(failure);
  const priorAttempts = await getPriorAttempts(failureId);
  const now = new Date();

  const decision = shouldAttemptRecovery(
    { amountPaise: failure.amountPaise, status: failure.status === "diagnosed" ? "diagnosed" : failure.status },
    diagnosis,
    priorAttempts,
    now,
  );

  if (!decision.proceed) {
    await recordStop(merchantId, failureId, priorAttempts.length + 1, decision);
    return {
      failureId,
      proceeded: false,
      recoveredPaise: 0,
      reason: decision.reason,
      stoppingRule: decision.stoppingRule,
    };
  }

  const strategy = chooseStrategy(diagnosis.category);
  const attemptNumber = priorAttempts.length + 1;

  // Inserted before executing, mirroring how attemptMoneyAction inserts
  // the money_actions row before calling Razorpay — a crash mid-flight
  // still leaves a traceable "pending" row rather than nothing.
  const [attemptRow] = await db
    .insert(schema.recoveryAttempts)
    .values({
      paymentFailureId: failureId,
      attemptNumber,
      strategy,
      outcome: "pending",
      reason: `Attempt ${attemptNumber}: strategy "${strategy}" chosen for decline category "${diagnosis.category}".`,
      recoveredPaise: 0,
      nextAttemptAt: nextAttemptTime(attemptNumber, now),
    })
    .returning();

  await db
    .update(schema.paymentFailures)
    .set({ status: "recovering" })
    .where(eq(schema.paymentFailures.id, failureId));

  if (strategy === "human_escalation") {
    const reason = `Routed to a human — ${decision.reason} Strategy chosen: human_escalation, no automatic money action taken.`;
    await db
      .update(schema.recoveryAttempts)
      .set({ outcome: "abandoned", reason, completedAt: new Date() })
      .where(eq(schema.recoveryAttempts.id, attemptRow.id));

    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "recovery_escalated_to_human",
      decision: "escalate",
      reason,
      metadata: { paymentFailureId: failureId, attemptNumber },
    });

    return { failureId, proceeded: true, strategy, outcome: "abandoned", recoveredPaise: 0, reason };
  }

  if (strategy === "write_off") {
    const reason = `Written off — ${diagnosis.rootCause} No recovery action is worth attempting.`;

    await db
      .update(schema.recoveryAttempts)
      .set({ outcome: "abandoned", reason, completedAt: new Date() })
      .where(eq(schema.recoveryAttempts.id, attemptRow.id));

    await db.update(schema.paymentFailures).set({ status: "written_off" }).where(eq(schema.paymentFailures.id, failureId));

    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "recovery_write_off",
      decision: "n/a",
      reason,
      metadata: { paymentFailureId: failureId, attemptNumber },
    });

    return { failureId, proceeded: true, strategy, outcome: "abandoned", recoveredPaise: 0, reason };
  }

  // retry_same_instrument / alternate_instrument / payment_link_nudge all
  // produce a real, payable Razorpay Payment Link (Layer 4-3) — through
  // the same gate and the same spend cap every other agent purchase goes
  // through. A gate denial (cap exhausted, no Razorpay account
  // connected) is a normal recorded outcome here, not an error. Unlike
  // an order, a Payment Link isn't paid at creation time — it's an
  // outcome that arrives later, asynchronously, when the customer
  // completes it — so a successful link creation is recorded as
  // "pending", not "failed": there is genuinely nothing more to know
  // yet. The payment_link.paid webhook is what later verifies and sets
  // recoveredPaise (see /api/webhooks/razorpay's handlePaymentLinkPaid).
  const idempotencyKey = `recovery:${failureId}:${attemptNumber}`;

  // The recovery agent has no agents.id of its own — it acts as the
  // merchant, not as any particular external buyer agent. attemptMoneyAction
  // requires an agentId for its bound checks (agent status, spend cap
  // lookup), so recovery attempts need a spend cap to answer to like any
  // other agent. Route through the merchant's designated recovery agent.
  const recoveryAgent = await getOrCreateRecoveryAgent(merchantId);

  const gateResult = await attemptMoneyAction({
    agentId: recoveryAgent.id,
    merchantId,
    type: "order_create",
    amountPaise: failure.amountPaise,
    context: `Recovery attempt ${attemptNumber} of failed payment ${failureId} — ${diagnosis.rootCause}`,
    idempotencyKey,
    paymentLink: {
      description: `Payment recovery — ${diagnosis.rootCause} (attempt ${attemptNumber})`,
      referenceId: attemptRow.id,
    },
  });

  if (gateResult.decision !== "allow" || !gateResult.paymentLinkUrl) {
    const reason = `Recovery attempt denied by the spend-cap gate: ${gateResult.reason}`;
    await db
      .update(schema.recoveryAttempts)
      .set({ outcome: "failed", reason, moneyActionId: gateResult.moneyActionId, completedAt: new Date() })
      .where(eq(schema.recoveryAttempts.id, attemptRow.id));

    return { failureId, proceeded: true, strategy, outcome: "failed", recoveredPaise: 0, reason };
  }

  const reason = `A real, payable link was created — generating it is real: ${gateResult.paymentLinkUrl}. Delivering it to the customer by email/SMS is not: no messaging provider is wired in this layer. Recorded as pending until the customer completes it, verified by the payment_link.paid webhook.`;

  await db
    .update(schema.recoveryAttempts)
    .set({
      outcome: "pending",
      reason,
      moneyActionId: gateResult.moneyActionId,
      razorpayPaymentLinkId: gateResult.paymentLinkId,
      paymentLinkUrl: gateResult.paymentLinkUrl,
    })
    .where(eq(schema.recoveryAttempts.id, attemptRow.id));

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "recovery_payment_link_created",
    decision: "n/a",
    reason,
    moneyActionId: gateResult.moneyActionId,
    metadata: { paymentFailureId: failureId, attemptNumber, paymentLinkUrl: gateResult.paymentLinkUrl },
  });

  return { failureId, proceeded: true, strategy, outcome: "pending", recoveredPaise: 0, reason };
}

/**
 * Called from the payment_link.paid webhook once Razorpay confirms a
 * recovery attempt's link was actually paid. This is the only place
 * recovery_attempts.recoveredPaise is ever set to a non-zero value —
 * always from a verified webhook amount, never optimistically from the
 * link merely having been created (same discipline the old
 * fetchOrder-based verification followed).
 */
export async function confirmRecoveryLinkPaid(
  razorpayPaymentLinkId: string,
  paidAmountPaise: number,
): Promise<void> {
  const [attempt] = await db
    .select()
    .from(schema.recoveryAttempts)
    .where(eq(schema.recoveryAttempts.razorpayPaymentLinkId, razorpayPaymentLinkId));

  if (!attempt) {
    console.warn(`[recovery] payment_link.paid for unknown link ${razorpayPaymentLinkId}, not attributable to a recovery attempt`);
    return;
  }

  if (attempt.outcome === "succeeded") return; // idempotent — a webhook redelivery is a no-op

  const [failure] = await db.select().from(schema.paymentFailures).where(eq(schema.paymentFailures.id, attempt.paymentFailureId));
  if (!failure) return;

  const reason = `Recovery succeeded — payment link ${razorpayPaymentLinkId} verified as paid via webhook. ₹${(paidAmountPaise / 100).toFixed(2)} recovered.`;

  await db
    .update(schema.recoveryAttempts)
    .set({ outcome: "succeeded", reason, recoveredPaise: paidAmountPaise, completedAt: new Date() })
    .where(eq(schema.recoveryAttempts.id, attempt.id));

  await db.update(schema.paymentFailures).set({ status: "recovered" }).where(eq(schema.paymentFailures.id, failure.id));

  await logAuditEntry({
    merchantId: failure.merchantId,
    actor: "system",
    event: "recovery_attempt_completed",
    decision: "allow",
    reason,
    moneyActionId: attempt.moneyActionId ?? undefined,
    metadata: { paymentFailureId: failure.id, attemptNumber: attempt.attemptNumber, recoveredPaise: paidAmountPaise },
  });
}

/**
 * The recovery pipeline acts on the merchant's behalf, not as any
 * external buyer agent, but attemptMoneyAction's bound checks (agent
 * status, spend cap lookup) require an agents.id. A dedicated, hidden
 * "recovery" agent per merchant gives the pipeline the same bounded
 * spend cap every other agent answers to, rather than a bypass —
 * created lazily and revoked/reactivated like any other agent if a
 * merchant chooses to cap it. It is never returned by the dashboard's
 * agent list.
 */
async function getOrCreateRecoveryAgent(merchantId: string) {
  const RECOVERY_AGENT_NAME = "__recovery_pipeline";

  const [existing] = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.merchantId, merchantId), eq(schema.agents.name, RECOVERY_AGENT_NAME)));

  if (existing) return existing;

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: RECOVERY_AGENT_NAME,
      apiKeyHash: hashApiKey(generateApiKey()),
      status: "active",
    })
    .returning();

  // A generous default cap so recovery isn't blocked out of the gate by
  // an accidental zero-cap merchant default — the real bound on recovery
  // spend is policy.ts's ROI governor, not this cap. A merchant can
  // tighten it like any other agent's cap from the dashboard once it's
  // surfaced there.
  const now = new Date();
  await db.insert(schema.spendCaps).values({
    agentId: agent.id,
    capPaise: 100_000_00,
    spentPaise: 0,
    perTransactionMaxPaise: 10_000_00,
    windowStart: now,
    windowEnd: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    status: "active",
  });

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "recovery_agent_provisioned",
    decision: "n/a",
    reason: "Provisioned the internal recovery pipeline agent and its spend cap on first use. Every recovery attempt that moves money is bounded by this cap the same way any external agent's purchases are.",
    metadata: { agentId: agent.id },
  });

  return agent;
}

export interface BatchResult {
  attempted: number;
  succeeded: number;
  recoveredPaise: number;
  writtenOff: number;
  stoppedByRule: Record<string, number>;
}

/**
 * The Track 03 headline. Runs sequentially, not Promise.all — every
 * recovery attempt shares the merchant's spend caps, and running them in
 * parallel turns cap exhaustion into a race whose per-row outcome
 * changes between runs. A batch total that isn't reproducible isn't a
 * measurement. Do not "optimise" this to run concurrently.
 */
export async function runRecoveryBatch(merchantId: string): Promise<BatchResult> {
  const failures = await db
    .select()
    .from(schema.paymentFailures)
    .where(eq(schema.paymentFailures.merchantId, merchantId));

  const pending = failures.filter((f) => f.status === "new" || f.status === "diagnosed" || f.status === "recovering");

  const result: BatchResult = {
    attempted: 0,
    succeeded: 0,
    recoveredPaise: 0,
    writtenOff: 0,
    stoppedByRule: {},
  };

  for (const failure of pending) {
    const outcome = await runRecoveryForFailure(merchantId, failure.id);
    if (!outcome.proceeded) {
      result.writtenOff += 1;
      const rule = outcome.stoppingRule ?? "unknown";
      result.stoppedByRule[rule] = (result.stoppedByRule[rule] ?? 0) + 1;
      continue;
    }
    result.attempted += 1;
    if (outcome.outcome === "succeeded") {
      result.succeeded += 1;
      result.recoveredPaise += outcome.recoveredPaise;
    }
  }

  const totalFailedPaise = pending.reduce((sum, f) => sum + f.amountPaise, 0);

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "recovery_batch_completed",
    decision: "n/a",
    reason: `Recovery batch: ${pending.length} failures processed, ${result.attempted} attempts made, ${result.succeeded} succeeded, ₹${(result.recoveredPaise / 100).toFixed(2)} of ₹${(totalFailedPaise / 100).toFixed(2)} recovered.`,
    metadata: { ...result },
  });

  return result;
}
