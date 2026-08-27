import { like } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { explainDecision } from "@/lib/explain-decision";
import { getUnifiedDecisions } from "@/lib/explainability";
import { logAuditEntry } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * Layer 7's required failure demo: the plain-language decision explainer
 * degrades to the complete recorded truth on a real model failure — no
 * crash, no blank panel, nothing lost from what a merchant can already
 * see and act on.
 *
 * Run with a deliberately corrupted Groq key, via the SHELL, not an
 * in-file process.env mutation:
 *
 *   GROQ_API_KEY=invalid npm run script scripts/demo-failure-explain-degrades.ts
 *
 * Why a shell override, not `process.env.GROQ_API_KEY = ...` inside this
 * file: static ESM imports resolve before this file's own top-level
 * statements run, so env.ts (and the Groq client it feeds) would already
 * be built off the real key by the time an in-file mutation executed —
 * confirmed the hard way on the first attempt (see FAILURES.md). A
 * dynamic import() inside main() was the first fix tried instead, and
 * failed differently: the "@/" path alias doesn't resolve inside a
 * dynamic import() under tsx (see FAILURES.md's earlier, still-standing
 * entry on the exact same pitfall from L1-1 — rediscovered here, now
 * cross-referenced so it isn't rediscovered a third time). An externally
 * set env var wins over `--env-file`, which is the actual fix.
 *
 * Repeatable, self-cleaning (try/finally-equivalent below), explicit
 * exit code (FAILURES.md — a missing exit reads as a hang).
 */

async function main() {
  console.log("=== Demo: the decision explainer degrades to the raw record on a real model failure ===\n");

  if (env.GROQ_API_KEY !== "invalid_key_forced_by_demo_script_do_not_use") {
    console.log("NOTE: GROQ_API_KEY was not overridden for this run — the explainer will likely succeed instead of degrading.");
    console.log("Re-run as: GROQ_API_KEY=invalid_key_forced_by_demo_script_do_not_use npm run script scripts/demo-failure-explain-degrades.ts\n");
  }

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  // A real, recorded refusal — the exact kind of row /dashboard/explain
  // shows every day. No product/agent fixtures needed since this is a
  // pure audit_log write, same shape checkBounds itself writes. The
  // reason text carries a distinctive marker so this script can find
  // and clean up its OWN fixture row afterward and nothing else
  // belonging to the real seeded merchant's genuine audit history.
  const FIXTURE_MARKER = `demo-failure-explain-degrades-${Date.now()}`;

  try {
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: `Denied — ₹1500.00 exceeds this agent's per-transaction limit of ₹1000.00, even though the window total may allow it. [${FIXTURE_MARKER}]`,
      boundApplied: "per_transaction_max:demo-fixture",
    });

    const [decision] = (await getUnifiedDecisions(merchant.id, { limit: 20 })).filter((d) => d.reason.includes(FIXTURE_MARKER));
    if (!decision) throw new Error("Could not find the fixture decision just written — getUnifiedDecisions/audit_log wiring is broken.");

    console.log("Recorded decision (this is the complete truth, regardless of what happens below):");
    console.log(`  Bound: ${decision.boundLabel}`);
    console.log(`  Reason: ${decision.reason}`);
    console.log(`  Determinism: ${decision.determinism}\n`);

    console.log("--- Asking the decision explainer for a plain-language explanation ---");
    const result = await explainDecision(decision);
    console.log(`  available: ${result.available}`);
    console.log(`  explanation: "${result.explanation}"\n`);

    if (result.available) {
      console.log("The explainer succeeded — re-run with the shell override shown above to see the degrade path this demo is actually about.");
    } else {
      console.log("Correctly degraded: available=false, no explanation generated.");
      console.log("The merchant reading /dashboard/explain right now would see the full recorded reason and bound above —");
      console.log("the explainer failing changes nothing about what they can already see and act on.");
    }
  } finally {
    // Scoped to exactly the one fixture row this script wrote, by its
    // own distinctive marker — NEVER a bare merchant-scoped delete,
    // since this runs against the real seeded merchant's genuine audit
    // history (see demo-failure-upsell-refused.ts's own comment on the
    // same discipline).
    await db.delete(schema.auditLog).where(like(schema.auditLog.reason, `%${FIXTURE_MARKER}%`));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
