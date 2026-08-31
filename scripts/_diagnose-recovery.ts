import { eq, like } from "drizzle-orm";
import { db, schema } from "@/lib/db";

async function main() {
  const agents = await db.select().from(schema.agents).where(like(schema.agents.name, "__recovery_pipeline%"));
  console.log("All __recovery_pipeline agents:", agents.length);
  for (const a of agents) {
    console.log(`  id=${a.id} status=${a.status} merchantId=${a.merchantId}`);
    const [gs] = await db.select().from(schema.agentGuardianState).where(eq(schema.agentGuardianState.agentId, a.id));
    console.log(`    guardian: ${gs ? JSON.stringify(gs) : "no row (normal)"}`);
  }

  const [cap] = await db
    .select()
    .from(schema.spendCaps)
    .where(eq(schema.spendCaps.agentId, agents[0]?.id ?? ""));
  console.log("\nSpend cap:", cap);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
