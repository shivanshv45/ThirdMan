import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Resets the buyer-agent scenario's transactional state between demo
 * runs — open negotiations and spent budget on the seeded agent — while
 * leaving the agent, its cap, its capabilities, and the seeded catalogue
 * in place (scripts/seed-buyer-agent.ts owns those). Run this between
 * live agent-buyer runs so each run starts from the same clean state,
 * the same repeatability discipline as every scripts/demo-failure-*.ts.
 */

const AGENT_NAME = "Buyer Agent (Layer 19, external)";

async function main() {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.name, AGENT_NAME));
  if (!agent) {
    console.log("No buyer agent found — nothing to reset. Run scripts/seed-buyer-agent.ts first.");
    return;
  }

  const negotiationRows = await db.select({ id: schema.negotiations.id }).from(schema.negotiations).where(eq(schema.negotiations.agentId, agent.id));

  // money_actions can be referenced by escalations (Layer 13's risk
  // layer can defer a purchase to pending_escalation) and can itself
  // reference a negotiation (negotiationId) — delete escalations and
  // audit_log before money_actions, before negotiations/negotiationTurns.
  // Same FK-ordering discipline demo-failure-negotiation-floor-holds.ts
  // follows for the negotiations half; the escalations half is the same
  // class of miss FAILURES.md already recorded twice for other table
  // pairs (Layer 18, Layer 23) — third occurrence, now fixed here too.
  const moneyActionRows = await db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id));
  for (const { id } of moneyActionRows) {
    await db.delete(schema.escalations).where(eq(schema.escalations.moneyActionId, id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.moneyActionId, id));
  }
  if (moneyActionRows.length > 0) {
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id));
  }

  for (const { id } of negotiationRows) {
    await db.delete(schema.negotiationTurns).where(eq(schema.negotiationTurns.negotiationId, id));
  }
  if (negotiationRows.length > 0) {
    await db.delete(schema.negotiations).where(eq(schema.negotiations.agentId, agent.id));
  }

  await db.update(schema.spendCaps).set({ spentPaise: 0 }).where(eq(schema.spendCaps.agentId, agent.id));

  console.log(`Reset buyer agent "${agent.name}": cleared ${negotiationRows.length} negotiation(s), ${moneyActionRows.length} money action(s), and re-zeroed spend.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reset FAILED:", err);
    process.exit(1);
  });
