import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db";

// Ensures the seeded active agent has a spend cap, for manual API testing.
async function main() {
  const keys = JSON.parse(readFileSync(path.resolve(__dirname, "../.seed-keys.local.json"), "utf8"));
  const { createHash } = await import("node:crypto");
  const activeHash = createHash("sha256").update(keys.active_agent).digest("hex");

  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.apiKeyHash, activeHash));
  if (!agent) throw new Error("Seeded active agent not found — run npm run script scripts/seed.ts first.");

  const [existingCap] = await db
    .select()
    .from(schema.spendCaps)
    .where(eq(schema.spendCaps.agentId, agent.id))
    .orderBy(desc(schema.spendCaps.createdAt))
    .limit(1);

  if (existingCap && existingCap.status === "active") {
    console.log("Active cap already exists:", existingCap.id);
    return;
  }

  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId: agent.id,
      capPaise: 500_000, // ₹5000
      spentPaise: 0,
      perTransactionMaxPaise: 200_000, // ₹2000
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();

  console.log("Created cap:", cap.id, "for agent:", agent.id);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
