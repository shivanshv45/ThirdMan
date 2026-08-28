import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { registerMerchantWebhook, setMerchantWebhookStatus, updateMerchantWebhook } from "@/lib/merchant-webhooks";

const cleanupMerchantIds: string[] = [];

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const id = cleanupMerchantIds.pop()!;
    await db.delete(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.merchantId, id));
    await db.delete(schema.merchantWebhooks).where(eq(schema.merchantWebhooks.merchantId, id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

describe("registerMerchantWebhook", () => {
  it("registers a webhook with an encrypted secret and logs an audit entry", async () => {
    const merchant = await createTestMerchant("webhook-mutation-test");
    cleanupMerchantIds.push(merchant.id);

    const { webhook, rawSecret } = await registerMerchantWebhook({
      merchantId: merchant.id,
      url: "https://merchant.example.com/webhooks/thirdman",
      events: ["order.paid"],
    });

    expect(webhook.url).toBe("https://merchant.example.com/webhooks/thirdman");
    expect(rawSecret.startsWith("whsec_")).toBe(true);
    expect(webhook.secretEncrypted).not.toBe(rawSecret);

    const [entry] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(entry?.event).toBe("merchant_webhook_registered");
  });

  it("rejects a private-range URL — SSRF prevention at the write boundary", async () => {
    const merchant = await createTestMerchant("webhook-mutation-ssrf");
    cleanupMerchantIds.push(merchant.id);

    await expect(
      registerMerchantWebhook({ merchantId: merchant.id, url: "https://192.168.1.1/hook", events: ["order.paid"] }),
    ).rejects.toThrow();
  });

  it("rejects a request with no valid subscribed events", async () => {
    const merchant = await createTestMerchant("webhook-mutation-noevents");
    cleanupMerchantIds.push(merchant.id);

    await expect(
      registerMerchantWebhook({ merchantId: merchant.id, url: "https://merchant.example.com/hook", events: ["not_a_real_event"] }),
    ).rejects.toThrow();
  });
});

describe("updateMerchantWebhook / setMerchantWebhookStatus", () => {
  it("is scoped to the owning merchant — cross-merchant update is denied", async () => {
    const merchantA = await createTestMerchant("webhook-mutation-a");
    const merchantB = await createTestMerchant("webhook-mutation-b");
    cleanupMerchantIds.push(merchantA.id, merchantB.id);

    const { webhook } = await registerMerchantWebhook({
      merchantId: merchantA.id,
      url: "https://merchant.example.com/hook",
      events: ["order.paid"],
    });

    await expect(
      updateMerchantWebhook({ merchantId: merchantB.id, webhookId: webhook.id, url: "https://evil.example.com/hook", events: ["order.paid"] }),
    ).rejects.toThrow(/not found/i);

    await expect(setMerchantWebhookStatus(merchantB.id, webhook.id, "disabled")).rejects.toThrow(/not found/i);
  });

  it("updates url and events for the owning merchant", async () => {
    const merchant = await createTestMerchant("webhook-mutation-update");
    cleanupMerchantIds.push(merchant.id);

    const { webhook } = await registerMerchantWebhook({
      merchantId: merchant.id,
      url: "https://merchant.example.com/hook",
      events: ["order.paid"],
    });

    const updated = await updateMerchantWebhook({
      merchantId: merchant.id,
      webhookId: webhook.id,
      url: "https://merchant.example.com/new-hook",
      events: ["order.paid", "order.refunded"],
    });

    expect(updated.url).toBe("https://merchant.example.com/new-hook");
    expect(updated.subscribedEvents).toEqual(["order.paid", "order.refunded"]);
  });
});
