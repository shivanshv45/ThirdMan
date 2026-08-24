import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { getRecentAuditEntries } from "@/lib/audit";

/**
 * Demo scenario 1 of 2 for Track 01's "one failure handled gracefully":
 * an agent tries to spend more than its cap allows. The gate denies it,
 * explains why, and nothing crashes or moves money. Repeatable — run
 * this any number of times for the pitch video.
 */
async function main() {
  console.log("=== Demo: agent exceeds its spend cap ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: "Demo Agent — Cap Exceeded Scenario",
      apiKeyHash: `demo_cap_exceeded_${Date.now()}`,
      status: "active",
    })
    .returning();

  try {
    const now = new Date();
    await db.insert(schema.spendCaps).values({
      agentId: agent.id,
      capPaise: 100_000, // ₹1000
      spentPaise: 0,
      perTransactionMaxPaise: 100_000,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    });

    console.log(`Agent "${agent.name}" authorised with a ₹1000 spend cap.\n`);
    console.log("Agent attempts to purchase an espresso machine for ₹1500 — over the cap.\n");

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 150_000,
      context: "Espresso Machine — Semi-Automatic",
    });

    console.log(`Gate decision: ${result.decision.toUpperCase()}`);
    console.log(`Reason: ${result.reason}\n`);

    if (result.decision !== "deny") {
      throw new Error(`Expected a deny, got ${result.decision} — demo scenario is broken`);
    }

    const trail = await getRecentAuditEntries(merchant.id, 5);
    const entry = trail.find((e) => e.reason === result.reason);
    console.log("Audit trail entry confirming this was logged:");
    console.log(`  [${entry?.decision.toUpperCase()}] ${entry?.reason}`);
    console.log(`  Bound applied: ${entry?.boundApplied}\n`);

    console.log("No money moved. No order was created. The system stayed correct.");
    console.log("The agent received a structured refusal it can read and act on — e.g. suggest a smaller purchase or wait for the next window.\n");
  } finally {
    // Cleanup runs even if a step above throws, so a demo run never
    // leaves stray state behind for the next run to trip over.
    await db
      .delete(schema.auditLog)
      .where(
        inArray(
          schema.auditLog.moneyActionId,
          db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id)),
        ),
      );
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id));
    await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
  }

  console.log("=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
