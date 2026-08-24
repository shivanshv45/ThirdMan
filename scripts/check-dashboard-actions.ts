import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getPendingEscalations } from "@/lib/dashboard";
import { setSpendCap, revokeAgent, reactivateAgent } from "@/lib/dashboard-mutations";
import { attemptMoneyAction, resolveEscalation } from "@/lib/gate";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Exercises the dashboard's mutation logic directly against real data.
 * The Server Action wrappers in app/dashboard/actions.ts are too thin
 * to need separate testing (FormData parsing + revalidatePath, which
 * requires a real Next.js request context this script doesn't have) —
 * this proves the actual logic those wrappers delegate to.
 */
async function main() {
  const merchant = await createTestMerchant("__dashboard_action_check_merchant__");

  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: "__dashboard_action_check_agent__",
      apiKeyHash: `dashboard_check_${Date.now()}`,
      status: "active",
    })
    .returning();

  console.log("Created check agent:", agent.id);

  // --- setSpendCap ---
  const cap = await setSpendCap({
    merchantId: merchant.id,
    agentId: agent.id,
    capRupees: 1000,
    perTransactionMaxRupees: 1000,
    windowHours: 24,
  });
  console.log("Cap after setSpendCap:", { capPaise: cap.capPaise, status: cap.status });
  if (cap.capPaise !== 100_000) throw new Error("setSpendCap did not persist the expected cap");

  // --- revokeAgent, must take effect immediately on the gate ---
  await revokeAgent(merchant.id, agent.id);

  const attemptAfterRevoke = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: merchant.id,
    type: "order_create",
    amountPaise: 10_000,
    context: "should be denied, agent just revoked",
  });
  console.log("Purchase attempt after revoke:", attemptAfterRevoke.decision, "-", attemptAfterRevoke.reason);
  if (attemptAfterRevoke.decision !== "deny") throw new Error("Revocation did not take effect immediately");

  // --- reactivateAgent ---
  const reactivated = await reactivateAgent(merchant.id, agent.id);
  console.log("Agent status after reactivate:", reactivated.status);
  if (reactivated.status !== "active") throw new Error("reactivateAgent did not persist");

  // --- resolveEscalation via approve: force a genuine escalation, then approve it ---
  const escalateAttempt = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: merchant.id,
    type: "order_create",
    amountPaise: 95_000, // 95% of this cap in one shot, reliably reads as risky
    context: "large purchase against nearly the whole cap, should escalate",
  });
  console.log("Escalation trigger attempt:", escalateAttempt.decision, "-", escalateAttempt.reason);
  if (escalateAttempt.decision !== "escalate") throw new Error("Expected this to escalate for the approve test");

  const pendingBefore = await getPendingEscalations(merchant.id);
  const ours = pendingBefore.find((e) => e.moneyAction.id === escalateAttempt.moneyActionId);
  if (!ours) throw new Error("Escalation not found in getPendingEscalations");

  const approveResult = await resolveEscalation(merchant.id, ours.id, "approved");
  console.log("resolveEscalation(approved):", approveResult.decision, approveResult.razorpayOrderId);
  if (approveResult.decision !== "allow") throw new Error("approveEscalation did not execute the action");

  // --- resolveEscalation via reject: a fresh cap, so the second purchase
  // is again ~95% of *its own* cap rather than a small remaining sliver.
  const cap2 = await setSpendCap({
    merchantId: merchant.id,
    agentId: agent.id,
    capRupees: 1000,
    perTransactionMaxRupees: 1000,
    windowHours: 24,
  });
  const escalateAttempt2 = await attemptMoneyAction({
    agentId: agent.id,
    merchantId: merchant.id,
    type: "order_create",
    amountPaise: 95_000,
    context: "another large purchase against a fresh cap, should escalate again",
  });
  console.log("Second escalation trigger attempt:", escalateAttempt2.decision, "-", escalateAttempt2.reason);
  if (escalateAttempt2.decision !== "escalate") throw new Error("Expected second attempt to escalate too");

  const pendingBefore2 = await getPendingEscalations(merchant.id);
  const ours2 = pendingBefore2.find((e) => e.moneyAction.id === escalateAttempt2.moneyActionId);
  if (!ours2) throw new Error("Second escalation not found");

  const rejectResult = await resolveEscalation(merchant.id, ours2.id, "rejected");
  console.log("resolveEscalation(rejected):", rejectResult.decision);
  if (rejectResult.decision !== "deny") throw new Error("rejectEscalation did not settle as denied");

  // Cleanup, scoped — see FAILURES.md on why unscoped deletes are unsafe.
  await db
    .delete(schema.escalations)
    .where(
      inArray(
        schema.escalations.spendCapId,
        db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id)),
      ),
    );
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
  await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
  await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));

  console.log("\nDashboard mutations check PASSED.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Dashboard mutations check FAILED:", err);
    process.exit(1);
  });
