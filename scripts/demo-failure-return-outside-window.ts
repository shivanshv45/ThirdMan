import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkReturnEligibility, openReturnRequest } from "@/lib/returns-desk";

/**
 * Layer 22's second required failure demo (plans/layer-22-returns-desk.md's
 * L22-8): a return request against a purchase outside the merchant's
 * published return window is refused deterministically, before any
 * model call, with the real policy clause named. No Groq call happens
 * in this scenario at all — checkReturnEligibility runs entirely in
 * code and denies before openReturnRequest ever reaches the
 * conversation.
 */
async function main() {
  console.log("=== Demo: a return request outside the published return window ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [existingPolicy] = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchant.id));

  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent — Returns Desk Outside Window", apiKeyHash: `demo_returns_window_${Date.now()}`, status: "active" })
    .returning();

  const windowDays = 14;
  const purchaseAge = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45 days ago

  const [moneyAction] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId: merchant.id,
      agentId: agent.id,
      type: "order_create",
      amountPaise: 42_000,
      status: "captured",
      razorpayEntityId: `order_demo_returns_window_${Date.now()}`,
      razorpayPaymentId: `pay_demo_returns_window_${Date.now()}`,
      createdAt: purchaseAge,
    })
    .returning();

  try {
    console.log(`1. Publishing a return policy: returns accepted within ${windowDays} days.`);
    await db
      .insert(schema.merchantPolicies)
      .values({ merchantId: merchant.id, returnsAccepted: true, returnWindowDays: windowDays })
      .onConflictDoUpdate({ target: schema.merchantPolicies.merchantId, set: { returnsAccepted: true, returnWindowDays: windowDays } });

    console.log(`2. A captured ₹${(moneyAction.amountPaise / 100).toFixed(2)} purchase exists, made 45 days ago — well outside the ${windowDays}-day window.\n`);

    console.log("3. Checking eligibility directly (the same check openReturnRequest runs before any model call):");
    const eligibility = await checkReturnEligibility(merchant.id, moneyAction.id, { agentId: agent.id });
    console.log(`   eligible: ${eligibility.eligible}`);
    console.log(`   failure: "${eligibility.failure}"`);
    console.log(`   reason: "${eligibility.reason}"\n`);

    if (eligibility.eligible) throw new Error("Expected this to be ineligible — demo scenario is broken");
    if (eligibility.failure !== "outside_window") throw new Error(`Expected failure "outside_window", got "${eligibility.failure}" — demo scenario is broken`);
    if (!eligibility.reason.includes(String(windowDays))) throw new Error("Expected the refusal reason to name the real policy window — demo scenario is broken");

    console.log("4. Opening a return request through the real entrypoint — refused before reaching the merchant's queue:");
    const opened = await openReturnRequest(merchant.id, moneyAction.id, { agentId: agent.id }, "I know it's late but I'd like a refund anyway.");
    console.log(`   status: "${opened.status}"`);
    if (opened.status !== "refused") throw new Error(`Expected status "refused", got "${opened.status}" — demo scenario is broken`);
    console.log(`   reason: "${opened.reason}"\n`);

    const openRequestsCount = (await db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.moneyActionId, moneyAction.id))).length;
    if (openRequestsCount !== 0) throw new Error("Expected no return_requests row to have been written — demo scenario is broken");
    console.log("5. No return_requests row was written at all — nothing reached the merchant's queue.\n");

    console.log("6. Reading back the real audit_log entry naming the exact bound:");
    const [auditEntry] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    if (!auditEntry) throw new Error("Expected a real return_request_refused audit entry — demo scenario is broken");
    console.log(`   "${auditEntry.reason}"`);
    console.log(`   boundApplied: "${auditEntry.boundApplied}"\n`);
    if (auditEntry.boundApplied !== "return_eligibility:outside_window") {
      throw new Error(`Expected boundApplied "return_eligibility:outside_window", got "${auditEntry.boundApplied}" — demo scenario is broken`);
    }

    console.log(
      "The claim never reached the model, let alone the merchant — code checked a real published policy against a real purchase date and refused deterministically, with the real clause named in the reason.",
    );
  } finally {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
    await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));
    if (existingPolicy) {
      await db
        .update(schema.merchantPolicies)
        .set({ returnsAccepted: existingPolicy.returnsAccepted, returnWindowDays: existingPolicy.returnWindowDays })
        .where(eq(schema.merchantPolicies.merchantId, merchant.id));
    } else {
      await db.delete(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchant.id));
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
