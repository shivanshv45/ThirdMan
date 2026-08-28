import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { updateEmbedOrigins, updateEmbedAppearance, setEmbedStatus } from "@/lib/embed-mutations";
import { getOrCreateEmbedConfig } from "@/lib/embed";

const cleanupMerchantIds: string[] = [];

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const id = cleanupMerchantIds.pop()!;
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

describe("updateEmbedOrigins", () => {
  it("normalises, dedupes, and persists a valid origin list, logging an audit entry", async () => {
    const merchant = await createTestMerchant("embed-mutation-origins");
    cleanupMerchantIds.push(merchant.id);

    const config = await updateEmbedOrigins({
      merchantId: merchant.id,
      origins: ["https://Shop.Example.com/", "https://shop.example.com", "https://other.example.com"],
    });

    expect(config.allowedOrigins).toEqual(["https://shop.example.com", "https://other.example.com"]);

    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(entries.some((e) => e.event === "embed_origins_updated")).toBe(true);
  });

  it("rejects an invalid origin loudly rather than silently dropping it", async () => {
    const merchant = await createTestMerchant("embed-mutation-invalid-origin");
    cleanupMerchantIds.push(merchant.id);

    await expect(
      updateEmbedOrigins({ merchantId: merchant.id, origins: ["not a url at all !!"] }),
    ).rejects.toThrow(/not a valid origin/i);
  });

  it("clearing the origin list is allowed, and says explicitly that it blocks the widget", async () => {
    const merchant = await createTestMerchant("embed-mutation-clear-origins");
    cleanupMerchantIds.push(merchant.id);

    await updateEmbedOrigins({ merchantId: merchant.id, origins: ["https://shop.example.com"] });
    const cleared = await updateEmbedOrigins({ merchantId: merchant.id, origins: [] });
    expect(cleared.allowedOrigins).toEqual([]);

    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    const clearEntry = entries.find((e) => e.reason.includes("cleared"));
    expect(clearEntry?.reason).toMatch(/refuse to load/i);
  });
});

describe("updateEmbedAppearance", () => {
  it("validates the accent colour and rejects an invalid one", async () => {
    const merchant = await createTestMerchant("embed-mutation-appearance-invalid");
    cleanupMerchantIds.push(merchant.id);

    await expect(
      updateEmbedAppearance({
        merchantId: merchant.id,
        displayName: "Test Shop",
        accentColor: "javascript:alert(1)",
        greeting: null,
        position: "bottom_right",
        negotiationEnabled: true,
        offersEnabled: true,
      }),
    ).rejects.toThrow(/not a valid hex colour/i);
  });

  it("persists a valid config, including the features flags", async () => {
    const merchant = await createTestMerchant("embed-mutation-appearance-valid");
    cleanupMerchantIds.push(merchant.id);

    const config = await updateEmbedAppearance({
      merchantId: merchant.id,
      displayName: "Test Shop",
      accentColor: "#1a8f5e",
      greeting: "Hi there!",
      position: "bottom_left",
      negotiationEnabled: false,
      offersEnabled: true,
    });

    expect(config.displayName).toBe("Test Shop");
    expect(config.accentColor).toBe("#1a8f5e");
    expect(config.position).toBe("bottom_left");
    expect(config.features).toEqual({ negotiation: false, offers: true });
  });
});

describe("setEmbedStatus", () => {
  it("disables and re-enables, each logging a distinct audit event", async () => {
    const merchant = await createTestMerchant("embed-mutation-status");
    cleanupMerchantIds.push(merchant.id);

    await getOrCreateEmbedConfig(merchant.id);

    const disabled = await setEmbedStatus(merchant.id, "disabled");
    expect(disabled.status).toBe("disabled");

    const reenabled = await setEmbedStatus(merchant.id, "active");
    expect(reenabled.status).toBe("active");

    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(entries.some((e) => e.event === "embed_disabled")).toBe(true);
    expect(entries.some((e) => e.event === "embed_enabled")).toBe(true);
  });
});
