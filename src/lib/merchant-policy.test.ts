import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { setMerchantPolicy } from "@/lib/dashboard-mutations";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";

/**
 * L5-3: merchant terms as structured data. What matters: an unset policy
 * reads as genuinely unset (not a fabricated permissive default), every
 * structured field round-trips exactly, and not-accepting-returns clears
 * the fields that only make sense alongside acceptance.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("merchant policy — structured, never a fabricated default", () => {
  it("a merchant with no policy row reads as genuinely unset, not permissive", async () => {
    const merchant = await createTestMerchant("__policy_test_unset__");
    createdMerchantIds.push(merchant.id);

    const policy = await getMerchantPolicy(merchant.id);
    expect(policy).toBeNull();
    expect(describeMerchantPolicy(policy)).toMatch(/not published/i);
  });

  it("every structured field round-trips exactly", async () => {
    const merchant = await createTestMerchant("__policy_test_roundtrip__");
    createdMerchantIds.push(merchant.id);

    await setMerchantPolicy({
      merchantId: merchant.id,
      returnsAccepted: true,
      returnWindowDays: 14,
      refundMethod: "store_credit",
      restockingFeePercent: 10,
      shippingRegions: ["IN", "US"],
      handlingTimeDays: 2,
      warrantyMonths: 12,
      policyNotes: "Contact support before returning electronics.",
    });

    const policy = await getMerchantPolicy(merchant.id);
    expect(policy).toMatchObject({
      returnsAccepted: true,
      returnWindowDays: 14,
      refundMethod: "store_credit",
      restockingFeePercent: 10,
      shippingRegions: ["IN", "US"],
      handlingTimeDays: 2,
      warrantyMonths: 12,
      policyNotes: "Contact support before returning electronics.",
    });

    expect(describeMerchantPolicy(policy)).toMatch(/14 days/);
    expect(describeMerchantPolicy(policy)).toMatch(/store credit/);
  });

  it("setting returnsAccepted false clears returnWindowDays/refundMethod rather than leaving them stale", async () => {
    const merchant = await createTestMerchant("__policy_test_clear__");
    createdMerchantIds.push(merchant.id);

    await setMerchantPolicy({
      merchantId: merchant.id,
      returnsAccepted: true,
      returnWindowDays: 30,
      refundMethod: "original_payment_method",
      restockingFeePercent: null,
      shippingRegions: [],
      handlingTimeDays: null,
      warrantyMonths: null,
      policyNotes: "",
    });

    await setMerchantPolicy({
      merchantId: merchant.id,
      returnsAccepted: false,
      returnWindowDays: 30, // stale input from the form, should be ignored/cleared
      refundMethod: "original_payment_method",
      restockingFeePercent: null,
      shippingRegions: [],
      handlingTimeDays: null,
      warrantyMonths: null,
      policyNotes: "",
    });

    const policy = await getMerchantPolicy(merchant.id);
    expect(policy?.returnsAccepted).toBe(false);
    expect(policy?.returnWindowDays).toBeNull();
    expect(policy?.refundMethod).toBeNull();
    expect(describeMerchantPolicy(policy)).toMatch(/does not accept returns/i);
  });

  it("rejects an out-of-range restocking fee percent", async () => {
    const merchant = await createTestMerchant("__policy_test_invalid__");
    createdMerchantIds.push(merchant.id);

    await expect(
      setMerchantPolicy({
        merchantId: merchant.id,
        returnsAccepted: true,
        returnWindowDays: 10,
        refundMethod: "either",
        restockingFeePercent: 150,
        shippingRegions: [],
        handlingTimeDays: null,
        warrantyMonths: null,
        policyNotes: "",
      }),
    ).rejects.toThrow(/0 and 100/);
  });

  it("re-saving upserts rather than creating a second row", async () => {
    const merchant = await createTestMerchant("__policy_test_upsert__");
    createdMerchantIds.push(merchant.id);

    await setMerchantPolicy({
      merchantId: merchant.id,
      returnsAccepted: true,
      returnWindowDays: 7,
      refundMethod: "either",
      restockingFeePercent: null,
      shippingRegions: [],
      handlingTimeDays: null,
      warrantyMonths: null,
      policyNotes: "",
    });
    await setMerchantPolicy({
      merchantId: merchant.id,
      returnsAccepted: true,
      returnWindowDays: 21,
      refundMethod: "either",
      restockingFeePercent: null,
      shippingRegions: [],
      handlingTimeDays: null,
      warrantyMonths: null,
      policyNotes: "",
    });

    const rows = await db.select().from(schema.merchantPolicies).where(eq(schema.merchantPolicies.merchantId, merchant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].returnWindowDays).toBe(21);
  });
});
