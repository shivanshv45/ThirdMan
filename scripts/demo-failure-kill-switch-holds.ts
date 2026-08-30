import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freezeAllAgents, unfreezeAllAgents, isFrozen } from "@/lib/guardian";
import { attemptMoneyAction } from "@/lib/gate";

/**
 * Layer 25's required failure demo: an agent transacting normally, the
 * Kill Switch thrown, the very next real purchase attempt denied by the
 * SAME guardian bound the Runtime Guardian already enforces (a bulk
 * application of an existing bound, not a new one), then unfrozen and
 * transacting again. "The whole product in fifteen seconds: money
 * moving, a human intervening, money stopping, and every step in the
 * audit log."
 */

async function main() {
  console.log("=== Demo: the Kill Switch stops a transacting agent, and unfreezing restores it ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: `Demo Agent — Kill Switch Scenario ${Date.now()}`,
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
    console.log(`1. A real agent "${agent.name}" with a real ₹10,000.00 spend cap, transacting normally.\n`);

    console.log("2. A dry-run purchase attempt — this passes every deterministic check:");
    const before = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "ordinary purchase, before the switch is thrown",
      dryRun: true,
    });
    console.log(`   ${before.decision.toUpperCase()} — ${before.reason}\n`);

    if (before.decision !== "allow") {
      throw new Error("Expected the pre-freeze dry run to be allowed — demo scenario is broken");
    }

    console.log("3. A human throws the Kill Switch — every active agent suspended, atomically, with a reason:");
    const { agentsFrozen } = await freezeAllAgents(merchant.id, "demo — simulated suspicious activity, freezing everything to be safe");
    console.log(`   ${agentsFrozen} agent(s) frozen. isFrozen(merchant) = ${await isFrozen(merchant.id)}\n`);

    console.log("4. The SAME agent tries the SAME purchase again. The real gate denies it at the guardian_state bound — before budget is ever reserved:");
    const duringFreeze = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "the same ordinary purchase, now correctly blocked",
    });
    console.log(`   ${duringFreeze.decision.toUpperCase()} — ${duringFreeze.reason}\n`);

    if (duringFreeze.decision !== "deny" || !duringFreeze.reason.toLowerCase().includes("suspended")) {
      throw new Error("Expected the purchase to be denied at the guardian_state bound while frozen — demo scenario is broken");
    }

    const [capDuringFreeze] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    console.log(`   spentPaise while frozen: ₹${(capDuringFreeze.spentPaise / 100).toFixed(2)} (unchanged)\n`);

    if (capDuringFreeze.spentPaise !== 0) {
      throw new Error("Expected spentPaise to remain 0 while frozen — demo scenario is broken");
    }

    console.log("5. The human releases the Kill Switch — every agent restored to its pre-freeze state:");
    const { agentsRestored } = await unfreezeAllAgents(merchant.id);
    console.log(`   ${agentsRestored} agent(s) restored. isFrozen(merchant) = ${await isFrozen(merchant.id)}\n`);

    console.log("6. The same purchase, one more time — money moves again:");
    const afterUnfreeze = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 20_000,
      context: "the same ordinary purchase, allowed again after unfreeze",
      dryRun: true,
    });
    console.log(`   ${afterUnfreeze.decision.toUpperCase()} — ${afterUnfreeze.reason}\n`);

    if (afterUnfreeze.decision !== "allow") {
      throw new Error("Expected the purchase to be allowed again after unfreeze — demo scenario is broken");
    }

    console.log(
      "Money moved normally, a human intervened with the Kill Switch, the next real purchase attempt was denied by the exact same bound the Runtime Guardian already enforces, and unfreezing put the agent right back where it was — every step written to the audit log.",
    );
  } finally {
    // Same FK-ordering discipline every other cleanup in this codebase
    // follows: audit_log and money_actions before agents, both
    // predicates (metadata->>'agentId' and money_action_id join) since
    // some events link only one way — see demo-failure-guardian-trip.ts.
    await db.execute(
      sql`delete from ${schema.auditLog} where metadata->>'agentId' = ${agent.id} or money_action_id in (select id from ${schema.moneyActions} where agent_id = ${agent.id})`,
    );
    await db.delete(schema.agentFreezeSnapshots).where(eq(schema.agentFreezeSnapshots.agentId, agent.id));
    await db.delete(schema.merchantFreezes).where(eq(schema.merchantFreezes.merchantId, merchant.id));
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
