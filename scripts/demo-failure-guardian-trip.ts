import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { evaluateAndTransition, rearmAgent } from "@/lib/guardian";
import { attemptMoneyAction } from "@/lib/gate";

/**
 * Layer 13's fourth required failure demo: a real retry-loop pattern
 * (the same amount/variant attempted repeatedly) trips the Runtime
 * Guardian's breaker across two real evaluations — normal -> throttled
 * -> suspended — with a real audit entry naming the exact signal and
 * baseline at each step. Once suspended, checkBounds denies at the
 * guardian_state bound, before budget is ever reserved for the next
 * attempt — a real merchant notification is enqueued, and the merchant
 * re-arms the agent to restore normal operation.
 *
 * No model anywhere near the detection or the block — the breach is
 * arithmetic against a rolling baseline, evaluated by real SQL against
 * real rows this demo itself writes.
 */

async function main() {
  console.log("=== Demo: a retry loop trips the Runtime Guardian, the agent is suspended, and re-arming restores it ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  // A dedicated agent with its own real Razorpay test-mode credentials,
  // isolated from the seeded merchant's real usage so this demo's
  // retry-loop signature can't be confused with genuine activity.
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: `Demo Agent — Guardian Trip Scenario ${Date.now()}`,
      apiKeyHash: `demo_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();

  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: agent.id,
      capPaise: 1_000_000,
      spentPaise: 0,
      perTransactionMaxPaise: 1_000_000,
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();

  try {
    console.log(`1. A real agent "${agent.name}" with a real ₹10,000.00 spend cap, currently in the "normal" Guardian state.\n`);

    console.log("2. Simulating a real retry-loop pattern: 7 real money_actions rows, all the same amount, in a tight window — the exact signature a runaway agent leaves behind...");
    for (let i = 0; i < 7; i++) {
      await db.insert(schema.moneyActions).values({
        merchantId: merchant.id,
        agentId: agent.id,
        amountPaise: 5_000,
        quantity: 1,
        type: "order_create",
        status: "denied",
      });
    }
    console.log("   7 rows written.\n");

    console.log("3. First evaluation — the Guardian's SQL-computed signals against this agent's own rolling baseline:");
    const first = await evaluateAndTransition(agent.id);
    console.log(`   ${first.transitioned ? "TRANSITIONED" : "no change"}: ${first.state} — signal="${first.evaluation.signal}", observed=${first.evaluation.observedValue}, baseline=${first.evaluation.baselineValue}\n`);

    if (!first.transitioned || first.state !== "throttled") {
      throw new Error(`Expected the first evaluation to move the agent to "throttled" — demo scenario is broken (got state="${first.state}", transitioned=${first.transitioned})`);
    }

    console.log("4. Second evaluation — the pattern persists, so the breaker advances again:");
    const second = await evaluateAndTransition(agent.id);
    console.log(`   ${second.transitioned ? "TRANSITIONED" : "no change"}: ${second.state}\n`);

    if (!second.transitioned || second.state !== "suspended") {
      throw new Error(`Expected the second evaluation to move the agent to "suspended" — demo scenario is broken (got state="${second.state}")`);
    }

    console.log("5. The agent tries a genuinely ordinary purchase next — well within its cap, nothing wrong with the request itself. The real gate denies it at the guardian_state bound, before budget is ever reserved:");
    const purchaseAttempt = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "an ordinary purchase, correctly blocked by the suspended state",
    });
    console.log(`   ${purchaseAttempt.decision.toUpperCase()} — ${purchaseAttempt.reason}\n`);

    if (purchaseAttempt.decision !== "deny" || !purchaseAttempt.reason.toLowerCase().includes("suspended")) {
      throw new Error("Expected the purchase to be denied at the guardian_state bound — demo scenario is broken");
    }

    const [capAfterDenial] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    console.log(`   spentPaise after the denied attempt: ₹${(capAfterDenial.spentPaise / 100).toFixed(2)} (unchanged — nothing was ever reserved)\n`);

    if (capAfterDenial.spentPaise !== 0) {
      throw new Error("Expected spentPaise to remain 0 — a suspended agent must never reserve budget — demo scenario is broken");
    }

    console.log("6. A real merchant notification was enqueued on suspension — reading it back from the real queue:");
    const [notification] = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.relatedEntityId, agent.id));
    console.log(`   subject: "${notification?.subject ?? "(none found)"}"\n`);

    if (!notification || notification.notificationType !== "guardian_trip") {
      throw new Error("Expected a real guardian_trip notification row — demo scenario is broken");
    }

    console.log("7. Merchant reviews the incident and re-arms the agent:");
    await rearmAgent(merchant.id, agent.id);
    const purchaseAfterRearm = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "the same ordinary purchase, now allowed after re-arm",
    });
    console.log(`   After re-arm: ${purchaseAfterRearm.decision.toUpperCase()} — ${purchaseAfterRearm.reason}\n`);

    if (purchaseAfterRearm.decision === "deny" && purchaseAfterRearm.reason.toLowerCase().includes("guardian")) {
      throw new Error("Expected the guardian_state bound to no longer block after re-arm — demo scenario is broken");
    }

    console.log(
      "A real retry-loop pattern tripped the breaker across two real evaluations, named the exact signal and baseline at each step, denied the next purchase before any budget was touched, notified the merchant through the real delivery queue, and released control back to the merchant on re-arm.",
    );
  } finally {
    // audit_log FKs into money_actions (the real purchase created after
    // re-arm), so it must be deleted first — the same ordering lesson
    // other test files' cleanup already follows for this FK direction.
    // Two predicates, not one: most rows here carry metadata->>'agentId',
    // but money_action_executed doesn't (see gate.ts) — it only links via
    // money_action_id, so both are needed to catch every row this demo
    // wrote. Scoped to this demo's own agent, never a blanket
    // merchant-wide delete — the seeded merchant has real history this
    // demo must not touch.
    await db.execute(
      sql`delete from ${schema.auditLog} where metadata->>'agentId' = ${agent.id} or money_action_id in (select id from ${schema.moneyActions} where agent_id = ${agent.id})`,
    );
    await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.relatedEntityId, agent.id));
    await db.delete(schema.guardianTransitions).where(eq(schema.guardianTransitions.agentId, agent.id));
    await db.delete(schema.agentGuardianState).where(eq(schema.agentGuardianState.agentId, agent.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
