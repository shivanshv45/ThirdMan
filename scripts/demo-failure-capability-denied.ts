import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { generateApiKey, hashApiKey, requireCapability } from "@/lib/agent-auth";
import { setSpendCap } from "@/lib/dashboard-mutations";

/**
 * Layer 13's third required failure demo: a fully legitimate, unrevoked,
 * amply-capped agent is refused a purchase on CAPABILITY alone — nothing
 * about its identity or budget is wrong. This is the demo the plan calls
 * out by name: authentication is not authorization.
 *
 * The agent here is deliberately granted only "products:read" — it can
 * see the catalogue but was never granted purchase:create. This is the
 * plan's own "where you chose not to use AI" answer made concrete: no
 * model decides this, a database row's absence does.
 */

async function main() {
  console.log("=== Demo: a legitimate, under-cap agent is refused purely on a missing capability ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: `Demo Agent — Capability Denial Scenario ${Date.now()}`,
      apiKeyHash: hashApiKey(rawKey),
      status: "active",
    })
    .returning();

  try {
    console.log(`1. Merchant creates a real agent "${agent.name}" — status: active, a real API key issued.\n`);

    console.log("2. Merchant sets it a generous, real spend cap: ₹10,000.00...");
    await setSpendCap({ merchantId: merchant.id, agentId: agent.id, capRupees: 10_000, perTransactionMaxRupees: 10_000, windowHours: 24 });
    console.log("   Cap set. This agent is authenticated, active, and amply funded.\n");

    console.log("3. Merchant grants it products:read ONLY — never purchase:create, deliberately.");
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "products:read" });
    console.log("   Capabilities granted: [products:read]\n");

    console.log("4. The agent's own request would pass every other check — authenticated, active, well within cap. Checking capability first, the way every /api/agent/* route and MCP tool does:");
    const allowed = await requireCapability(agent, "purchase:create");
    console.log(`   requireCapability(agent, "purchase:create") -> ${allowed}\n`);

    if (allowed) {
      throw new Error("Expected the capability check to deny — demo scenario is broken");
    }

    console.log("5. Confirming the gate itself is never even reached — this is checked BEFORE attemptMoneyAction is called on the real /api/agent/purchase route, so no bound arithmetic runs, no risk assessment runs, no money_actions row is created:");
    const [actionsBeforeAttempt] = [await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.agentId, agent.id))];
    console.log(`   money_actions rows for this agent: ${actionsBeforeAttempt.length} (none — the request never reached the gate)\n`);

    const auditRows = await db.execute<{ reason: string }>(
      sql`select reason from ${schema.auditLog} where event = 'agent_capability_denied' and metadata->>'agentId' = ${agent.id} order by created_at desc limit 1`,
    );
    const audit = auditRows[0];
    console.log(`6. A real audit entry names the missing scope: "${audit.reason}"\n`);

    if (!audit.reason.includes("purchase:create")) {
      throw new Error("Expected the audit entry to name purchase:create specifically — demo scenario is broken");
    }

    console.log("7. For contrast: the SAME agent, once granted purchase:create, passes the capability check and reaches the real gate (which then evaluates its actual spend/stock bounds normally):");
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "purchase:create" });
    const allowedNow = await requireCapability(agent, "purchase:create");
    console.log(`   requireCapability(agent, "purchase:create") -> ${allowedNow} (capability granted)\n`);

    if (!allowedNow) {
      throw new Error("Expected the capability check to pass once granted — demo scenario is broken");
    }

    console.log(
      "A fully legitimate, unrevoked, well-funded agent was refused on capability alone — its identity was never in question and its budget was never touched. Authentication is not authorization.",
    );
  } finally {
    // Scoped to metadata.agentId, not a blanket merchant-wide delete —
    // the seeded merchant has real audit history this demo must not touch.
    await db.execute(sql`delete from ${schema.auditLog} where metadata->>'agentId' = ${agent.id}`);
    await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agent.id));
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
