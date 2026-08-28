import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { sendMerchantDigestIfDue } from "@/lib/notifications/merchant-alerts";

/**
 * Layer 11-6: the merchant digest. Three real bounds under test — an
 * empty digest never sends (it trains a merchant to stop reading),
 * a disabled alert type is genuinely excluded from the count that
 * decides whether to send at all, and at most one digest per merchant
 * per day (lastDigestSentAt).
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.merchantId, merchantId));
    await db.delete(schema.merchantAlertSettings).where(eq(schema.merchantAlertSettings.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("sendMerchantDigestIfDue", () => {
  it("does not send when there is nothing to report", async () => {
    const merchant = await createTestMerchant("__digest_test_empty__");
    createdMerchantIds.push(merchant.id);

    const result = await sendMerchantDigestIfDue(merchant.id);
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/nothing to report/i);

    const rows = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.merchantId, merchant.id));
    expect(rows.length).toBe(0);
  });

  it("sends once, then refuses a second send within 24 hours even if there's more to report", async () => {
    const merchant = await createTestMerchant("__digest_test_once_daily__");
    createdMerchantIds.push(merchant.id);

    // Simulate one exhausted notification worth reporting.
    await db.insert(schema.notificationDeliveries).values({
      merchantId: merchant.id,
      recipientKind: "customer",
      notificationType: "restock_alert",
      subject: "test",
      bodyText: "test",
      status: "exhausted",
      lastAttemptAt: new Date(),
    });

    const first = await sendMerchantDigestIfDue(merchant.id);
    expect(first.sent).toBe(true);

    const second = await sendMerchantDigestIfDue(merchant.id);
    expect(second.sent).toBe(false);
    expect(second.reason).toMatch(/already sent/i);

    const merchantRows = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.merchantId, merchant.id));
    // Exactly one digest row (plus the one seeded exhausted row) — no double-send.
    expect(merchantRows.filter((r) => r.recipientKind === "merchant").length).toBe(1);
  });

  it("excludes a disabled alert type from the count that decides whether to send", async () => {
    const merchant = await createTestMerchant("__digest_test_disabled_type__");
    createdMerchantIds.push(merchant.id);

    await db.insert(schema.notificationDeliveries).values({
      merchantId: merchant.id,
      recipientKind: "customer",
      notificationType: "restock_alert",
      subject: "test",
      bodyText: "test",
      status: "exhausted",
      lastAttemptAt: new Date(),
    });
    await db.insert(schema.merchantAlertSettings).values({
      merchantId: merchant.id,
      escalationPendingEnabled: false,
      holdExpiringEnabled: false,
      notificationExhaustedEnabled: false, // the only thing that would have triggered a send
      webhookExhaustedEnabled: false,
    });

    const result = await sendMerchantDigestIfDue(merchant.id);
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/nothing to report/i);
  });
});
