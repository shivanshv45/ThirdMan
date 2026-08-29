import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueCheckoutMandate, verifyPaymentMandate } from "@/lib/mandates";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";

/**
 * Layer 13's first required failure demo: a real ES256-signed Checkout
 * Mandate, minted with a negative expiry so it is already expired at
 * issuance, is presented as a Payment Mandate binding and REFUSED —
 * before the gate, the risk layer, or any model is ever consulted. The
 * refusal is deterministic (an expiry timestamp comparison), so this
 * demo never depends on a live model call succeeding, matching the
 * established demo-failure-*.ts pattern (FAILURES.md, L6-7/L8-6).
 *
 * Repeatable, self-cleaning (try/finally), explicit exit code on both
 * paths.
 */

async function main() {
  console.log("=== Demo: an expired Payment Mandate is refused before the model is ever consulted ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const agent = await getOrCreateStorefrontAgent(merchant.id);
  let demoMandateId: string | undefined;

  try {
    console.log("1. Merchant signs a real Checkout Mandate, deliberately with a -1 second expiry (already expired at issuance)...");
    const { jwt, checkoutHash, expiresAt } = await issueCheckoutMandate(
      {
        merchantId: merchant.id,
        agentId: agent.id,
        currency: "INR",
        totalPaise: 50_000,
        lines: [{ variantId: crypto.randomUUID(), sku: "DEMO-SKU", quantity: 1, unitPricePaise: 50_000 }],
      },
      -1,
    );
    console.log(`   Signed. checkout_hash=${checkoutHash.slice(0, 16)}…, expiresAt=${expiresAt.toISOString()} (already in the past)\n`);

    console.log("2. Agent presents this exact mandate as its Payment Mandate binding for a ₹500.00 checkout...");
    const verification = await verifyPaymentMandate({
      merchantId: merchant.id,
      agentId: agent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 50_000,
    });

    console.log(`   Result: ${verification.ok ? "VERIFIED" : "DENIED"}${verification.ok ? "" : ` — "${verification.reason}"`}\n`);

    if (verification.ok) {
      throw new Error("Expected the expired mandate to be denied — demo scenario is broken");
    }
    if (!verification.reason.toLowerCase().includes("expired")) {
      throw new Error(`Expected the denial reason to name expiry specifically, got: "${verification.reason}" — demo scenario is broken`);
    }

    const [mandate] = await db.select().from(schema.checkoutMandates).where(eq(schema.checkoutMandates.checkoutHash, checkoutHash));
    const [record] = await db
      .select()
      .from(schema.mandateVerifications)
      .where(eq(schema.mandateVerifications.checkoutMandateId, mandate.id));
    console.log(`3. Real mandate_verifications row read back: outcome="${record.outcome}", failureReason="${record.failureReason}".\n`);

    if (record.outcome !== "failed" || record.failureReason !== "expired") {
      throw new Error(`Expected a real "failed"/"expired" verification row — demo scenario is broken`);
    }

    console.log("A real ES256-signed mandate, real database evidence, denied purely on a deterministic expiry check — no model, no gate, no Razorpay call ever reached.");

    demoMandateId = mandate.id;
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
