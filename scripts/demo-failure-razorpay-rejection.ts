import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { getRecentAuditEntries } from "@/lib/audit";

/**
 * Demo scenario 2 of 2: a purchase clears every deterministic bound and
 * reserves budget, then Razorpay itself rejects the order (here, an
 * amount below Razorpay's real minimum — a genuine rejection, not a
 * simulated one). The gate releases the reserved budget and records
 * both the attempt and the recovery. Repeatable — run any number of
 * times for the pitch video.
 */
async function main() {
  console.log("=== Demo: Razorpay rejects a reserved purchase, budget is released ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: "Demo Agent — Razorpay Rejection Scenario",
      apiKeyHash: `demo_razorpay_rejection_${Date.now()}`,
      status: "active",
    })
    .returning();

  try {
    const now = new Date();
    const [cap] = await db
      .insert(schema.spendCaps)
      .values({
        agentId: agent.id,
        capPaise: 100_000, // ₹1000
        spentPaise: 0,
        perTransactionMaxPaise: 100_000,
        windowStart: now,
        windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: "active",
      })
      .returning();

    console.log(`Agent "${agent.name}" authorised with a ₹1000 spend cap.\n`);
    console.log("Agent attempts a purchase for ₹0.01 — clears every bound check, but is below Razorpay's real minimum order amount.\n");

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId: merchant.id,
      type: "order_create",
      amountPaise: 1,
      context: "a purchase amount too small for Razorpay to accept",
    });

    console.log(`Gate decision: ${result.decision.toUpperCase()}`);
    console.log(`Reason: ${result.reason}\n`);

    if (result.decision !== "deny" || !result.reason.includes("released")) {
      throw new Error("Expected a deny with budget released — demo scenario is broken");
    }

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    console.log(`Cap balance after the failed attempt: ₹${(updatedCap.spentPaise / 100).toFixed(2)} spent of ₹${(updatedCap.capPaise / 100).toFixed(2)}.`);
    console.log("The reservation was released — a failed payment did not consume the agent's budget.\n");

    const trail = await getRecentAuditEntries(merchant.id, 5);
    const entry = trail.find((e) => e.reason === result.reason);
    console.log("Audit trail entry recording both the attempt and the recovery:");
    console.log(`  [${entry?.decision.toUpperCase()}] ${entry?.reason}\n`);

    console.log("The system recovered on its own: budget released, action marked failed, nothing crashed.");
    console.log("The agent can retry with a valid amount using the same remaining budget.\n");
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
