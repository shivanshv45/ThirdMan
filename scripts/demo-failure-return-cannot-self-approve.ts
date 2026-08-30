import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { openReturnRequest, generateReturnRecommendation, recordReturnMessage } from "@/lib/returns-desk";

/**
 * Layer 22's headline failure demo (plans/layer-22-returns-desk.md's
 * L22-8): whatever the AI recommends, nothing moves. A return request
 * fed through the real recommendation pipeline — even with a claim
 * clean and sympathetic enough that a reasonable model might well
 * recommend approval — ends in a request still awaiting the merchant:
 * the refund was never issued, the money action's status never
 * changed, and no ledger movement occurred.
 *
 * This isn't a mocked model response — it's a real Groq call. What
 * matters isn't what the model actually said; it's that returns-desk.ts
 * (the module holding that call) has no import of gate.ts at all — see
 * returns-desk.isolation.test.ts for the static proof this demo makes
 * visible end to end, and returns-desk.recommendation.test.ts for the
 * same behavioural assertion run against every possible recommendation
 * value in CI.
 */
async function main() {
  console.log("=== Demo: whatever the AI recommends, nothing moves ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: "Demo Agent — Returns Desk Cannot Self-Approve", apiKeyHash: `demo_returns_selfapprove_${Date.now()}`, status: "active" })
    .returning();

  const [moneyAction] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId: merchant.id,
      agentId: agent.id,
      type: "order_create",
      amountPaise: 74_900,
      status: "captured",
      razorpayEntityId: `order_demo_returns_${Date.now()}`,
      razorpayPaymentId: `pay_demo_returns_${Date.now()}`,
    })
    .returning();

  try {
    console.log(`1. A captured ₹${(moneyAction.amountPaise / 100).toFixed(2)} purchase exists (money_actions ${moneyAction.id}, status "captured").\n`);

    console.log("2. The buyer opens a return request with a clean, specific, genuinely sympathetic claim:");
    const opened = await openReturnRequest(
      merchant.id,
      moneyAction.id,
      { agentId: agent.id },
      "The item arrived with a cracked case on delivery — I have photos. I'd like a full refund.",
    );
    if (opened.requestId === null) throw new Error(`Expected the request to open, got refused: ${opened.reason}`);
    console.log(`   return_requests ${opened.requestId} — status: "${opened.status}"\n`);

    console.log("3. The buyer adds one more clarifying detail, as the desk's conversation would gather:");
    await recordReturnMessage(opened.requestId, "buyer", "It was damaged before I even opened the box, within an hour of delivery. I'd like to send it back.");

    console.log("4. Asking the model for its recommendation (a real Groq call, not mocked):");
    await generateReturnRecommendation(merchant.id, opened.requestId);

    const [request] = await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, opened.requestId));
    console.log(`   modelRecommendation: "${request.modelRecommendation}"`);
    console.log(`   modelSummary: "${request.modelSummary}"\n`);

    console.log("5. Reading back the request and the money action after the recommendation was generated:");
    console.log(`   return_requests.status: "${request.status}" (still awaiting the merchant, regardless of what the model recommended)`);
    console.log(`   return_requests.approvedAmountPaise: ${request.approvedAmountPaise} (null — no amount was ever set by the recommendation)`);

    const [freshAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
    console.log(`   money_actions.status: "${freshAction.status}" (unchanged — issueRefund was never called)`);
    console.log(`   money_actions.razorpayPaymentId: "${freshAction.razorpayPaymentId}" (unchanged, no refund id anywhere)\n`);

    if (request.status !== "awaiting_merchant") throw new Error(`Expected status "awaiting_merchant", got "${request.status}" — demo scenario is broken`);
    if (request.approvedAmountPaise !== null) throw new Error("Expected approvedAmountPaise to be null — demo scenario is broken");
    if (freshAction.status !== "captured") throw new Error(`Expected money action status unchanged at "captured", got "${freshAction.status}" — demo scenario is broken`);

    const refundAuditRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    const anyRefundEvent = refundAuditRows.some((r) => r.event === "money_action_refunded" || r.event === "return_request_approved");
    if (anyRefundEvent) throw new Error("Expected no refund-related audit entry — demo scenario is broken");
    console.log(`6. Audit trail for this money action has ${refundAuditRows.length} entr${refundAuditRows.length === 1 ? "y" : "ies"} — none of them a refund.\n`);

    console.log(
      `The model's recommendation was "${request.modelRecommendation}" — whatever it says, it has no function it can call that issues a refund. returns-desk.ts, the module holding this exact call, has zero import of gate.ts. Only a merchant's own click on /dashboard/returns reaches issueRefund.`,
    );
  } finally {
    const requestIds = await db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.moneyActionId, moneyAction.id));
    for (const r of requestIds) {
      await db.delete(schema.returnRequestMessages).where(eq(schema.returnRequestMessages.returnRequestId, r.id));
    }
    await db.delete(schema.returnRequests).where(eq(schema.returnRequests.moneyActionId, moneyAction.id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.moneyActionId, moneyAction.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, moneyAction.id));
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
