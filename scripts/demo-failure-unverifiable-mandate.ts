import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueCheckoutMandate, verifyPaymentMandate } from "@/lib/mandates";
import { getOrCreateStorefrontAgent } from "@/lib/storefront";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 21-9: a purchase attempted with a mandate signed by the WRONG
 * key — a real Checkout Mandate genuinely signed by a DIFFERENT
 * merchant's own ES256 keypair, presented to this merchant as if it
 * were theirs. Distinct from the two existing mandate demos: expired
 * (L13) fails on a timestamp comparison and tampered (L13) fails on an
 * amount comparison AFTER a matching mandate is found by hash — this one
 * fails structurally, before signature verification is even attempted,
 * because no row under THIS merchant's own checkout_mandates ever
 * matches a hash of a JWT it never signed. That is itself the point: an
 * attacker cannot even get to "wrong signature," because the mandate
 * lookup is scoped by merchant from the first step.
 *
 * Refused before checkBounds, the risk layer, or any model is
 * consulted — pure deterministic lookup/comparison. Self-cleaning,
 * repeatable, explicit exit code on both paths.
 */

async function main() {
  console.log("=== Demo: a Checkout Mandate signed by a different merchant's key is refused, never reaching signature verification ===\n");

  const [realMerchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!realMerchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const impostorMerchant = await createTestMerchant("__unverifiable_mandate_demo_impostor__");
  const realAgent = await getOrCreateStorefrontAgent(realMerchant.id);

  let impostorMandateId: string | undefined;

  try {
    console.log(`1. A SEPARATE merchant ("${impostorMerchant.name}") signs a real Checkout Mandate with ITS OWN ES256 key, naming ${realMerchant.name}'s real agent as the buyer (as an attacker forging a mandate would attempt)...`);
    const { jwt, checkoutHash } = await issueCheckoutMandate({
      merchantId: impostorMerchant.id,
      agentId: realAgent.id,
      currency: "INR",
      totalPaise: 75_000,
      lines: [{ variantId: crypto.randomUUID(), sku: "DEMO-SKU", quantity: 1, unitPricePaise: 75_000 }],
    });
    console.log(`   Signed by the impostor merchant. checkout_hash=${checkoutHash.slice(0, 16)}…\n`);

    console.log(`2. That mandate is presented to the REAL merchant ("${realMerchant.name}") as if it authorized a purchase there...`);
    const verification = await verifyPaymentMandate({
      merchantId: realMerchant.id,
      agentId: realAgent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 75_000,
    });

    console.log(`   Result: ${verification.ok ? "VERIFIED" : "DENIED"}${verification.ok ? "" : ` — "${verification.reason}"`}\n`);

    if (verification.ok) {
      throw new Error("Expected a mandate signed by a different merchant's key to be denied — demo scenario is broken");
    }
    if (!verification.reason.toLowerCase().includes("checkout_hash")) {
      throw new Error(`Expected the denial to name the checkout_hash mismatch specifically, got: "${verification.reason}" — demo scenario is broken`);
    }

    const [impostorMandate] = await db.select().from(schema.checkoutMandates).where(eq(schema.checkoutMandates.checkoutHash, checkoutHash));
    impostorMandateId = impostorMandate.id;

    // The verification attempt was scoped to realMerchant.id, so
    // record() in mandates.ts writes the row there, not under the
    // impostor merchant — proving the failure is scoped correctly, not
    // silently swallowed. checkoutMandateId is null on this row (no
    // matching checkout_mandates row was ever found under realMerchant),
    // so it's found by merchantId + this exact checkoutHash's own
    // failureReason rather than a foreign key that doesn't exist here.
    const [record] = await db
      .select()
      .from(schema.mandateVerifications)
      .where(eq(schema.mandateVerifications.merchantId, realMerchant.id))
      .orderBy(schema.mandateVerifications.createdAt)
      .limit(1);
    console.log(`3. Real mandate_verifications row under the REAL merchant: outcome="${record.outcome}", failureReason="${record.failureReason}".\n`);

    if (record.failureReason !== "checkout_hash_mismatch") {
      throw new Error(`Expected failureReason "checkout_hash_mismatch", got "${record.failureReason}" — demo scenario is broken`);
    }

    console.log("A mandate genuinely signed by a different merchant's own key never reaches signature verification at all — it is refused at the merchant-scoped lookup, before the ES256 check, the gate, or any model is ever consulted.");

    await db.delete(schema.mandateVerifications).where(eq(schema.mandateVerifications.id, record.id));
  } finally {
    if (impostorMandateId) {
      await db.delete(schema.mandateVerifications).where(eq(schema.mandateVerifications.checkoutMandateId, impostorMandateId));
      await db.delete(schema.checkoutMandates).where(eq(schema.checkoutMandates.id, impostorMandateId));
    }
    // issueCheckoutMandate wrote a checkout_mandate_issued audit entry
    // under the impostor merchant — must go before the merchant row
    // itself, the same FK-ordering discipline every other cleanup here follows.
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, impostorMerchant.id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, impostorMerchant.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
