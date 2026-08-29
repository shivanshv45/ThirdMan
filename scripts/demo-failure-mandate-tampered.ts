import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueCheckoutMandate, verifyPaymentMandate } from "@/lib/mandates";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";

/**
 * Layer 13's second required failure demo: a cart's total is altered
 * AFTER the merchant signed the Checkout Mandate for it — the agent
 * (or something in between) tries to check out at a different amount
 * than what was signed. checkout_hash / totalPaise comparison denies,
 * deterministically, before any money moves. Same no-model-dependency
 * shape as the other demos — this refusal is pure integer comparison.
 */

async function main() {
  console.log("=== Demo: a cart total altered after signing is refused on the checkout_hash/amount mismatch ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const agent = await getOrCreateStorefrontAgent(merchant.id);
  let demoMandateId: string | undefined;

  try {
    console.log("1. Merchant signs a real Checkout Mandate for a ₹1,000.00 cart...");
    const { jwt, checkoutHash } = await issueCheckoutMandate({
      merchantId: merchant.id,
      agentId: agent.id,
      currency: "INR",
      totalPaise: 100_000,
      lines: [{ variantId: crypto.randomUUID(), sku: "DEMO-SKU", quantity: 2, unitPricePaise: 50_000 }],
    });
    console.log(`   Signed for ₹1,000.00. checkout_hash=${checkoutHash.slice(0, 16)}…\n`);

    console.log("2. The agent presents the SAME signed mandate, but now asserts a different amount — ₹1,500.00, as if a line item were added after signing...");
    const verification = await verifyPaymentMandate({
      merchantId: merchant.id,
      agentId: agent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 150_000, // tampered — the signed mandate says 100,000
    });

    console.log(`   Result: ${verification.ok ? "VERIFIED" : "DENIED"}${verification.ok ? "" : ` — "${verification.reason}"`}\n`);

    if (verification.ok) {
      throw new Error("Expected the amount mismatch to be denied — demo scenario is broken");
    }
    if (!verification.reason.toLowerCase().includes("total")) {
      throw new Error(`Expected the denial to name the total mismatch specifically, got: "${verification.reason}" — demo scenario is broken`);
    }

    const [mandate] = await db.select().from(schema.checkoutMandates).where(eq(schema.checkoutMandates.checkoutHash, checkoutHash));
    demoMandateId = mandate.id;

    const [record] = await db.select().from(schema.mandateVerifications).where(eq(schema.mandateVerifications.checkoutMandateId, mandate.id));
    console.log(`3. Real mandate_verifications row: outcome="${record.outcome}", failureReason="${record.failureReason}".\n`);

    if (record.failureReason !== "amount_mismatch") {
      throw new Error(`Expected failureReason "amount_mismatch", got "${record.failureReason}" — demo scenario is broken`);
    }

    console.log("4. The mandate is NOT consumed by a failed verification — the buyer can retry with the correct, honestly-signed amount:");
    const [stillIssued] = await db.select({ status: schema.checkoutMandates.status }).from(schema.checkoutMandates).where(eq(schema.checkoutMandates.id, mandate.id));
    console.log(`   mandate status: "${stillIssued.status}" (not consumed)\n`);

    const correctedVerification = await verifyPaymentMandate({
      merchantId: merchant.id,
      agentId: agent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 100_000, // the honest, signed amount
    });
    console.log(`   Retried at the real signed amount: ${correctedVerification.ok ? "VERIFIED" : "DENIED"}\n`);

    if (!correctedVerification.ok) {
      throw new Error("Expected the retry at the correct amount to verify — demo scenario is broken");
    }

    console.log("A cart altered after the merchant signed it is refused on integer paise comparison alone — never a float, never a tolerance — and the same mandate still redeems correctly once the honest amount is presented.");
  } finally {
    if (demoMandateId) {
      await db.delete(schema.mandateVerifications).where(eq(schema.mandateVerifications.checkoutMandateId, demoMandateId));
      await db.delete(schema.checkoutMandates).where(eq(schema.checkoutMandates.id, demoMandateId));
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
