import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { setModelBudget, getUseCaseBudgetStatus, routeCompletion } from "@/lib/model-router";

/**
 * Layer 14's required failure demo: a real AI use case's model budget
 * (funded from the treasury's merchant_ai_budget bucket) is exhausted by
 * genuine spend from a real Groq call, and the very next real call for
 * that use case degrades deterministically to the cheapest known tier
 * instead of silently overspending past its allocation. No model
 * anywhere near the degrade decision — it's a real integer-paise
 * comparison against real, queried spend.
 */

async function main() {
  console.log("=== Demo: a use case's AI model budget is exhausted, and the next call degrades instead of overspending ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const useCase = "classification" as const;

  // Record whatever budget row already existed for this use case (there
  // may be none) so this demo can restore it exactly, rather than
  // leaving the seeded merchant's real config altered by a demo run.
  const [preExistingBudget] = await db
    .select()
    .from(schema.modelBudgets)
    .where(sql`${schema.modelBudgets.merchantId} = ${merchant.id} and ${schema.modelBudgets.useCase} = ${useCase}`);

  try {
    console.log(`1. Setting a real, generous budget for "${useCase}" so the first real call is genuinely served at the premium tier...`);
    await setModelBudget(merchant.id, useCase, 10_000_00); // ₹10,000
    const before = await getUseCaseBudgetStatus(merchant.id, useCase);
    console.log(`   budget: ₹${(before.budgetPaise / 100).toFixed(2)}, spent so far: ₹${(before.spentPaise / 100).toFixed(2)}\n`);

    console.log("2. A real Groq call, long enough to accrue genuine, non-zero cost:");
    const longPrompt =
      "Classify the sentiment of this customer message in one word (positive, negative, or neutral), then explain your reasoning in two sentences: 'The product arrived a week late and the box was damaged, but support resolved it quickly and I'm satisfied with the outcome.'";
    const first = await routeCompletion(merchant.id, useCase, { prompt: longPrompt });
    console.log(`   served by ${first.modelId} (${first.provider}), real cost: ₹${(first.costPaise / 100).toFixed(2)}, degraded: ${first.degraded}\n`);

    if (first.degraded) {
      throw new Error("Expected the first call to be served at the premium tier with real budget available — demo scenario is broken");
    }
    if (first.costPaise <= 0) {
      throw new Error("Expected the first real call to accrue a non-zero cost — demo scenario is broken");
    }

    console.log("3. Now setting the budget to EXACTLY what was already spent — the use case's allocation is genuinely exhausted, not fabricated:");
    await setModelBudget(merchant.id, useCase, first.costPaise);
    const afterExhaust = await getUseCaseBudgetStatus(merchant.id, useCase);
    console.log(`   budget: ₹${(afterExhaust.budgetPaise / 100).toFixed(2)}, spent: ₹${(afterExhaust.spentPaise / 100).toFixed(2)}, remaining: ₹${(afterExhaust.remainingPaise / 100).toFixed(2)}\n`);

    if (afterExhaust.remainingPaise !== 0) {
      throw new Error("Expected remaining budget to be exactly 0 — demo scenario is broken");
    }

    console.log("4. The next real call for this same use case — the router checks real remaining budget BEFORE calling, and degrades to the cheapest known tier:");
    const second = await routeCompletion(merchant.id, useCase, { prompt: "Say 'ok' and nothing else." });
    console.log(`   served by ${second.modelId} (${second.provider}), degraded: ${second.degraded}\n`);

    if (!second.degraded || second.modelId !== "openai/gpt-oss-20b") {
      throw new Error("Expected the second call to degrade to the cheapest tier — demo scenario is broken");
    }

    console.log("5. A real audit entry records the degrade, naming the exact bound:");
    const [degradeEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.merchantId} = ${merchant.id} and ${schema.auditLog.event} = 'model_budget_degraded'`)
      .orderBy(sql`${schema.auditLog.createdAt} desc`)
      .limit(1);
    console.log(`   "${degradeEntry?.reason ?? "(none found)"}"\n`);

    if (!degradeEntry) {
      throw new Error("Expected a real model_budget_degraded audit entry — demo scenario is broken");
    }

    console.log(
      "A real use case's AI budget was genuinely exhausted by real spend, and the very next call degraded deterministically to the cheapest known tier instead of silently overspending — the same bound gate.ts's spend caps enforce for money, applied here to AI operating cost.",
    );
  } finally {
    await db.delete(schema.auditLog).where(sql`${schema.auditLog.merchantId} = ${merchant.id} and ${schema.auditLog.event} = 'model_budget_degraded'`);
    await db.delete(schema.auditLog).where(sql`${schema.auditLog.merchantId} = ${merchant.id} and ${schema.auditLog.event} = 'treasury_model_spend'`);
    await db.delete(schema.modelCallCosts).where(sql`${schema.modelCallCosts.merchantId} = ${merchant.id} and ${schema.modelCallCosts.useCase} = ${useCase}`);
    await db.delete(schema.treasuryLedger).where(sql`${schema.treasuryLedger.merchantId} = ${merchant.id} and ${schema.treasuryLedger.reason} = 'model_spend'`);

    // Restore this use case's budget row to exactly what it was before
    // this demo ran, rather than leaving the seeded merchant's real
    // config permanently altered by a demo script.
    if (preExistingBudget) {
      await db.update(schema.modelBudgets).set({ budgetPaise: preExistingBudget.budgetPaise, periodStart: preExistingBudget.periodStart }).where(eq(schema.modelBudgets.id, preExistingBudget.id));
    } else {
      await db.delete(schema.modelBudgets).where(sql`${schema.modelBudgets.merchantId} = ${merchant.id} and ${schema.modelBudgets.useCase} = ${useCase}`);
    }
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
