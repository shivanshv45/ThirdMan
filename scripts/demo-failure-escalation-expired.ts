import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { expirePendingEscalations } from "@/lib/notifications/expiry";

/**
 * Layer 11-7's required failure demo: an escalation that sits pending
 * past its review window is auto-denied, and its reserved budget is
 * provably released — the same shape as the cap-exceeded and
 * out-of-stock demos, on a new surface (a bound enforced by
 * deterministic code, denied by default, and logged as evidence).
 * Repeatable, self-cleaning.
 */
async function main() {
  console.log("=== Demo: an escalation nobody answered is auto-denied and its budget released ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent — Escalation Expiry Scenario", apiKeyHash: `demo_expiry_${Date.now()}`, status: "active" })
    .returning();

  const capPaise = 100_000_00;
  const reservedPaise = 30_000_00;
  const now = new Date();

  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: agent.id,
      capPaise,
      // Already reflects the reservation, same as a real escalation would leave it.
      spentPaise: reservedPaise,
      perTransactionMaxPaise: capPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();

  try {
    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchant.id, agentId: agent.id, type: "order_create", amountPaise: reservedPaise, status: "pending_escalation" })
      .returning();

    const past = new Date(Date.now() - 60 * 60 * 1000); // 1 hour past its review window
    const [escalation] = await db
      .insert(schema.escalations)
      .values({ moneyActionId: moneyAction.id, spendCapId: cap.id, riskReason: "Demo: this purchase looked unusual and nobody answered in time.", expiresAt: past })
      .returning();

    console.log(`Escalation created ${escalation.expiresAt.toISOString()} in the past — a merchant who never opened the dashboard.`);
    console.log(`₹${(reservedPaise / 100).toFixed(2)} is currently reserved against a ₹${(capPaise / 100).toFixed(2)} cap.\n`);

    console.log("Running the same sweep POST /api/cron/run's escalations:expire job runs...\n");
    const result = await expirePendingEscalations();
    console.log(`Swept: ${result.expired} escalation(s) expired.\n`);

    if (result.expired !== 1) {
      throw new Error(`Expected exactly 1 escalation expired, got ${result.expired}`);
    }

    const [updatedEscalation] = await db.select().from(schema.escalations).where(eq(schema.escalations.id, escalation.id));
    const [updatedAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));

    console.log(`Escalation outcome: ${updatedEscalation.outcome} (never "approved" — timing out denies, never auto-approves)`);
    console.log(`Money action status: ${updatedAction.status}`);
    console.log(`Cap remaining after: ₹${((capPaise - updatedCap.spentPaise) / 100).toFixed(2)} of ₹${(capPaise / 100).toFixed(2)} — back to the full amount.\n`);

    if (updatedEscalation.outcome !== "rejected") throw new Error(`Expected outcome "rejected", got "${updatedEscalation.outcome}"`);
    if (updatedAction.status !== "failed") throw new Error(`Expected money action status "failed", got "${updatedAction.status}"`);
    if (updatedCap.spentPaise !== 0) throw new Error(`Expected the reserved ${reservedPaise} paise fully released (spentPaise 0), got ${updatedCap.spentPaise}`);

    const [auditEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.event, "escalation_expired"))
      .orderBy(schema.auditLog.createdAt);
    const ownAuditEntries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    const expiryEntry = ownAuditEntries.find((e) => e.event === "escalation_expired" && (e.metadata as { escalationId?: string })?.escalationId === escalation.id);
    if (!expiryEntry) throw new Error("Expected a real 'escalation_expired' audit_log row naming the stopping rule — none found");
    console.log(`Real audit_log row read back: "${expiryEntry.reason}"`);
    void auditEntry;

    console.log("\nThe bound is real: no merchant response within the review window denies the purchase and gives every paisa back — deterministic code, not a model, decided it.");
  } finally {
    const moneyActionIds = (await db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id))).map((a) => a.id);
    if (moneyActionIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.moneyActionId, moneyActionIds));
      await db.delete(schema.escalations).where(inArray(schema.escalations.moneyActionId, moneyActionIds));
      await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.id, moneyActionIds));
    }
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
