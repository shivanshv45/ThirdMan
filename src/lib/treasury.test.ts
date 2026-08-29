import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { fundTreasuryFromCapture, setTreasurySettings, getTreasuryOverview } from "@/lib/treasury";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 14-1: real-DB proof that fundTreasuryFromCapture is opt-in,
 * splits exactly as configured, and is idempotent against the same
 * double-confirmation race every other capture-time side effect in this
 * codebase already guards against (reward coins, webhooks).
 */

async function makeMoneyAction(merchantId: string, amountPaise: number) {
  const [row] = await db
    .insert(schema.moneyActions)
    .values({ merchantId, type: "order_create", amountPaise, status: "captured" })
    .returning();
  return row;
}

describe("fundTreasuryFromCapture", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;
    await db.delete(schema.treasuryLedger).where(eq(schema.treasuryLedger.merchantId, currentMerchantId));
    await db.delete(schema.treasurySettings).where(eq(schema.treasurySettings.merchantId, currentMerchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("is a silent no-op with no treasury_settings row", async () => {
    const merchant = await createTestMerchant("__treasury_test_no_settings__");
    merchantId = merchant.id;
    const moneyAction = await makeMoneyAction(merchantId, 100_000);

    await fundTreasuryFromCapture(merchantId, moneyAction.id, 100_000);

    const overview = await getTreasuryOverview(merchantId);
    expect(overview.buyerCreditsPaise).toBe(0);
    expect(overview.merchantAiBudgetPaise).toBe(0);
    expect(overview.reservePaise).toBe(0);
  });

  it("is a silent no-op when settings exist but enabled is false", async () => {
    const merchant = await createTestMerchant("__treasury_test_disabled__");
    merchantId = merchant.id;
    await setTreasurySettings(merchantId, { allocationBasisPoints: 500, buyerShareBps: 4000, merchantShareBps: 4000, reserveShareBps: 2000, enabled: false });
    const moneyAction = await makeMoneyAction(merchantId, 100_000);

    await fundTreasuryFromCapture(merchantId, moneyAction.id, 100_000);

    const overview = await getTreasuryOverview(merchantId);
    expect(overview.buyerCreditsPaise).toBe(0);
  });

  it("funds all three buckets exactly as configured, real rows read back", async () => {
    const merchant = await createTestMerchant("__treasury_test_funds__");
    merchantId = merchant.id;
    await setTreasurySettings(merchantId, { allocationBasisPoints: 1000, buyerShareBps: 5000, merchantShareBps: 3000, reserveShareBps: 2000, enabled: true });
    const moneyAction = await makeMoneyAction(merchantId, 1_000_00); // ₹1000 captured

    await fundTreasuryFromCapture(merchantId, moneyAction.id, 1_000_00);

    // contribution = floor(100000 * 1000 / 10000) = 10000 paise (₹100)
    // buyer = floor(10000 * 5000/10000) = 5000, merchant = floor(10000*3000/10000)=3000, reserve = 10000-5000-3000=2000
    const overview = await getTreasuryOverview(merchantId);
    expect(overview.buyerCreditsPaise).toBe(5000);
    expect(overview.merchantAiBudgetPaise).toBe(3000);
    expect(overview.reservePaise).toBe(2000);

    const rows = await db.select().from(schema.treasuryLedger).where(eq(schema.treasuryLedger.merchantId, merchantId));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.reason === "capture_allocation")).toBe(true);
  });

  it("is idempotent — a second call for the same capture funds nothing more", async () => {
    const merchant = await createTestMerchant("__treasury_test_idempotent__");
    merchantId = merchant.id;
    await setTreasurySettings(merchantId, { allocationBasisPoints: 1000, buyerShareBps: 5000, merchantShareBps: 3000, reserveShareBps: 2000, enabled: true });
    const moneyAction = await makeMoneyAction(merchantId, 1_000_00);

    await fundTreasuryFromCapture(merchantId, moneyAction.id, 1_000_00);
    await fundTreasuryFromCapture(merchantId, moneyAction.id, 1_000_00);

    const overview = await getTreasuryOverview(merchantId);
    expect(overview.buyerCreditsPaise).toBe(5000);
    expect(overview.merchantAiBudgetPaise).toBe(3000);
    expect(overview.reservePaise).toBe(2000);

    const rows = await db.select().from(schema.treasuryLedger).where(eq(schema.treasuryLedger.merchantId, merchantId));
    expect(rows.length).toBe(3);
  });
});

describe("setTreasurySettings", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;
    await db.delete(schema.treasurySettings).where(eq(schema.treasurySettings.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("rejects shares that don't sum to 10000 and writes nothing", async () => {
    const merchant = await createTestMerchant("__treasury_test_bad_shares__");
    merchantId = merchant.id;

    const result = await setTreasurySettings(merchantId, { allocationBasisPoints: 500, buyerShareBps: 5000, merchantShareBps: 5000, reserveShareBps: 5000, enabled: true });
    expect(result.ok).toBe(false);

    const settings = await db.select().from(schema.treasurySettings).where(eq(schema.treasurySettings.merchantId, merchantId));
    expect(settings.length).toBe(0);
  });

  it("accepts a legal config and is upsertable", async () => {
    const merchant = await createTestMerchant("__treasury_test_good_shares__");
    merchantId = merchant.id;

    const first = await setTreasurySettings(merchantId, { allocationBasisPoints: 500, buyerShareBps: 4000, merchantShareBps: 4000, reserveShareBps: 2000, enabled: true });
    expect(first.ok).toBe(true);

    const second = await setTreasurySettings(merchantId, { allocationBasisPoints: 800, buyerShareBps: 5000, merchantShareBps: 3000, reserveShareBps: 2000, enabled: true });
    expect(second.ok).toBe(true);

    const [settings] = await db.select().from(schema.treasurySettings).where(eq(schema.treasurySettings.merchantId, merchantId));
    expect(settings.allocationBasisPoints).toBe(800);
  });
});
