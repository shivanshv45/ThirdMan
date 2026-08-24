import { like, or, inArray, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

// One-off: removes merchants (and their cascaded rows) left behind by
// test runs that crashed before their afterEach cleanup could finish,
// from before the FK-ordering fix documented in FAILURES.md.
async function main() {
  const orphaned = await db
    .select()
    .from(schema.merchants)
    .where(
      or(
        like(schema.merchants.name, "\\_\\_gate\\_test%"),
        like(schema.merchants.name, "\\_\\_escalation\\_test%"),
        like(schema.merchants.name, "\\_\\_idempotency\\_test%"),
        like(schema.merchants.name, "\\_\\_stress\\_test%"),
        like(schema.merchants.name, "\\_\\_schema\\_check%"),
        like(schema.merchants.name, "\\_\\_audit\\_test%"),
        like(schema.merchants.name, "\\_\\_debug%"),
      ),
    );

  console.log(`Found ${orphaned.length} orphaned test merchant(s).`);
  if (orphaned.length === 0) return;

  const merchantIds = orphaned.map((m) => m.id);
  const agents = await db.select().from(schema.agents).where(inArray(schema.agents.merchantId, merchantIds));
  const agentIds = agents.map((a) => a.id);

  if (agentIds.length > 0) {
    const caps = await db.select().from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
    const capIds = caps.map((c) => c.id);
    if (capIds.length > 0) {
      await db.delete(schema.escalations).where(inArray(schema.escalations.spendCapId, capIds));
    }
    await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
  }

  // audit_log rows now carry their own merchant_id directly (not just via
  // money_actions), so delete by merchant_id rather than only via the join.
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.merchantId, merchantIds));
  await db.delete(schema.moneyActions).where(inArray(schema.moneyActions.merchantId, merchantIds));
  await db.delete(schema.agents).where(inArray(schema.agents.merchantId, merchantIds));
  await db.delete(schema.merchants).where(inArray(schema.merchants.id, merchantIds));

  console.log("Cleaned up orphaned test data.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
