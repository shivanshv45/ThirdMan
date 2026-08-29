import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { issueCheckoutMandate, verifyPaymentMandate, getOrCreateMandateKeypair } from "@/lib/mandates";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 13-3: AP2 mandate verification. Every check is deterministic and
 * fail-closed — no model anywhere near this. Real DB, real ES256
 * signatures via jose, no mocks.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__mandates_test_${Date.now()}_${Math.random()}__`,
      email: `mandates_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: "__mandates_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

describe("AP2 mandate verification", () => {
  let merchantId: string | undefined;
  let agentId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentId = agentId;
    merchantId = undefined;
    agentId = undefined;

    await db.delete(schema.mandateVerifications).where(eq(schema.mandateVerifications.merchantId, currentMerchantId));
    await db.delete(schema.checkoutMandates).where(eq(schema.checkoutMandates.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    if (currentAgentId) {
      await db.delete(schema.agents).where(eq(schema.agents.id, currentAgentId));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("generates a keypair lazily on first use and reuses it on subsequent calls", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;

    const [before] = await db.select({ pub: schema.merchants.mandatePublicKey }).from(schema.merchants).where(eq(schema.merchants.id, merchantId));
    expect(before.pub).toBeNull();

    const first = await getOrCreateMandateKeypair(merchantId);
    const second = await getOrCreateMandateKeypair(merchantId);
    expect(first.publicKeySpki).toBe(second.publicKeySpki);

    const [after] = await db.select({ pub: schema.merchants.mandatePublicKey }).from(schema.merchants).where(eq(schema.merchants.id, merchantId));
    expect(after.pub).toBe(first.publicKeySpki);
  });

  it("a valid, unexpired, unconsumed mandate presented with the matching amount verifies successfully", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const { jwt } = await issueCheckoutMandate({
      merchantId,
      agentId: agent.id,
      currency: "INR",
      totalPaise: 85_000,
      lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 85_000 }],
    });

    const result = await verifyPaymentMandate({
      merchantId,
      agentId: agent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 85_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.totalPaise).toBe(85_000);

    const [verification] = await db.select().from(schema.mandateVerifications).where(eq(schema.mandateVerifications.merchantId, merchantId));
    expect(verification.outcome).toBe("verified");
  });

  it("denies before the model/gate is ever reached when the mandate is expired", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    // -1 second: already expired at issuance.
    const { jwt } = await issueCheckoutMandate(
      {
        merchantId,
        agentId: agent.id,
        currency: "INR",
        totalPaise: 50_000,
        lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 50_000 }],
      },
      -1,
    );

    const result = await verifyPaymentMandate({
      merchantId,
      agentId: agent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 50_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);

    const [verification] = await db.select().from(schema.mandateVerifications).where(eq(schema.mandateVerifications.merchantId, merchantId));
    expect(verification.outcome).toBe("failed");
    expect(verification.failureReason).toBe("expired");
  });

  it("denies when the cart total no longer matches the signed checkout — the tampered-cart demo", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const { jwt } = await issueCheckoutMandate({
      merchantId,
      agentId: agent.id,
      currency: "INR",
      totalPaise: 100_000,
      lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 100_000 }],
    });

    // Caller asserts a different amount than what was signed.
    const result = await verifyPaymentMandate({
      merchantId,
      agentId: agent.id,
      checkoutJwt: jwt,
      assertedAmountPaise: 150_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/total/i);

    const [verification] = await db.select().from(schema.mandateVerifications).where(eq(schema.mandateVerifications.merchantId, merchantId));
    expect(verification.failureReason).toBe("amount_mismatch");

    // The mandate must NOT be consumed by a failed verification — a
    // buyer can retry with the correct amount against the same mandate.
    const [mandate] = await db.select().from(schema.checkoutMandates).where(eq(schema.checkoutMandates.merchantId, merchantId));
    expect(mandate.status).toBe("issued");
  });

  it("denies a tampered JWT — modifying the payload after signing invalidates it, caught by the checkout_hash lookup finding nothing", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const { jwt } = await issueCheckoutMandate({
      merchantId,
      agentId: agent.id,
      currency: "INR",
      totalPaise: 100_000,
      lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 100_000 }],
    });

    // Flip one character in the payload segment — a real tamper attempt.
    const parts = jwt.split(".");
    const tampered = [parts[0], parts[1].slice(0, -1) + (parts[1].slice(-1) === "A" ? "B" : "A"), parts[2]].join(".");

    const result = await verifyPaymentMandate({
      merchantId,
      agentId: agent.id,
      checkoutJwt: tampered,
      assertedAmountPaise: 100_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no checkout mandate found/i);
  });

  it("replay protection: a mandate can be redeemed exactly once — the second presentation is denied", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentId = agent.id;

    const { jwt } = await issueCheckoutMandate({
      merchantId,
      agentId: agent.id,
      currency: "INR",
      totalPaise: 60_000,
      lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 60_000 }],
    });

    const first = await verifyPaymentMandate({ merchantId, agentId: agent.id, checkoutJwt: jwt, assertedAmountPaise: 60_000 });
    expect(first.ok).toBe(true);

    const second = await verifyPaymentMandate({ merchantId, agentId: agent.id, checkoutJwt: jwt, assertedAmountPaise: 60_000 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already been redeemed/i);
  });

  it("cross-merchant isolation: a mandate signed for merchant A cannot be verified by looking it up under merchant B", async () => {
    const merchantA = await makeMerchant();
    merchantId = merchantA.id;
    const agentA = await makeAgent(merchantA.id);
    agentId = agentA.id;

    const merchantB = await makeMerchant();
    try {
      const { jwt } = await issueCheckoutMandate({
        merchantId: merchantA.id,
        agentId: agentA.id,
        currency: "INR",
        totalPaise: 40_000,
        lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 40_000 }],
      });

      const result = await verifyPaymentMandate({
        merchantId: merchantB.id,
        agentId: agentA.id,
        checkoutJwt: jwt,
        assertedAmountPaise: 40_000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no checkout mandate found/i);
    } finally {
      await db.delete(schema.mandateVerifications).where(eq(schema.mandateVerifications.merchantId, merchantB.id));
      await db.delete(schema.checkoutMandates).where(eq(schema.checkoutMandates.merchantId, merchantB.id));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantB.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantB.id));
    }
  });

  it("denies when a different agent than the one the mandate was issued to presents it", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agentA = await makeAgent(merchant.id);
    agentId = agentA.id;
    const agentB = await makeAgent(merchant.id);

    try {
      const { jwt } = await issueCheckoutMandate({
        merchantId,
        agentId: agentA.id,
        currency: "INR",
        totalPaise: 30_000,
        lines: [{ variantId: "00000000-0000-0000-0000-000000000000", sku: "TEST-SKU", quantity: 1, unitPricePaise: 30_000 }],
      });

      const result = await verifyPaymentMandate({
        merchantId,
        agentId: agentB.id,
        checkoutJwt: jwt,
        assertedAmountPaise: 30_000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/different agent/i);
    } finally {
      await db.delete(schema.agents).where(eq(schema.agents.id, agentB.id));
    }
  });
});
