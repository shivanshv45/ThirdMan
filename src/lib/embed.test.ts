import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import {
  assertNotSecretKey,
  generatePublishableKey,
  getOrCreateEmbedConfig,
  isOriginAllowed,
  isValidHexColor,
  normalizeOrigin,
  resolveEmbedKey,
  rotatePublishableKey,
} from "@/lib/embed";

const cleanupMerchantIds: string[] = [];

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const id = cleanupMerchantIds.pop()!;
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

describe("normalizeOrigin", () => {
  it("normalises scheme, lowercases the host, and drops trailing slashes/paths", () => {
    expect(normalizeOrigin("https://Shop.Example.com/")).toBe("https://shop.example.com");
    expect(normalizeOrigin("https://shop.example.com")).toBe("https://shop.example.com");
    expect(normalizeOrigin("https://shop.example.com/some/path")).toBe("https://shop.example.com");
  });

  it("assumes https when no scheme is given", () => {
    expect(normalizeOrigin("shop.example.com")).toBe("https://shop.example.com");
  });

  it("preserves a non-default port", () => {
    expect(normalizeOrigin("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("returns null for garbage input", () => {
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin("not a url at all !!")).toBeNull();
    expect(normalizeOrigin("ftp://shop.example.com")).toBeNull();
  });
});

describe("isOriginAllowed", () => {
  it("denies when the allowlist is empty — 'not configured' is never 'allow everything'", () => {
    expect(isOriginAllowed({ allowedOrigins: [], status: "active" }, "https://shop.example.com")).toBe(false);
  });

  it("denies when the request has no Origin header", () => {
    expect(isOriginAllowed({ allowedOrigins: ["https://shop.example.com"], status: "active" }, null)).toBe(false);
  });

  it("denies when the embed is disabled, regardless of the allowlist", () => {
    expect(isOriginAllowed({ allowedOrigins: ["https://shop.example.com"], status: "disabled" }, "https://shop.example.com")).toBe(
      false,
    );
  });

  it("allows an exact, normalised match", () => {
    expect(isOriginAllowed({ allowedOrigins: ["https://shop.example.com"], status: "active" }, "https://shop.example.com")).toBe(
      true,
    );
    // Trailing slash / case in the incoming Origin still matches, since
    // both sides are normalised before comparison.
    expect(isOriginAllowed({ allowedOrigins: ["https://shop.example.com"], status: "active" }, "https://Shop.Example.com/")).toBe(
      true,
    );
  });

  it("denies a origin that merely contains the allowed one as a substring", () => {
    expect(
      isOriginAllowed({ allowedOrigins: ["https://shop.example.com"], status: "active" }, "https://evilshop.example.com"),
    ).toBe(false);
    expect(
      isOriginAllowed({ allowedOrigins: ["https://example.com"], status: "active" }, "https://notexample.com"),
    ).toBe(false);
  });

  it("denies a different port than the one allowed", () => {
    expect(isOriginAllowed({ allowedOrigins: ["https://shop.example.com"], status: "active" }, "https://shop.example.com:8443")).toBe(
      false,
    );
  });
});

describe("isValidHexColor", () => {
  it("accepts 3- and 6-digit hex colours", () => {
    expect(isValidHexColor("#fff")).toBe(true);
    expect(isValidHexColor("#1a8f5e")).toBe(true);
  });

  it("rejects anything that isn't a plain hex colour", () => {
    expect(isValidHexColor("red")).toBe(false);
    expect(isValidHexColor("#gggggg")).toBe(false);
    expect(isValidHexColor("javascript:alert(1)")).toBe(false);
    expect(isValidHexColor("#fff; background: url(x)")).toBe(false);
  });
});

describe("assertNotSecretKey", () => {
  it("throws on an sk_-prefixed value", () => {
    expect(() => assertNotSecretKey("sk_abc123")).toThrow(/agent secret key/i);
  });

  it("does not throw on a pk_-prefixed value", () => {
    expect(() => assertNotSecretKey("pk_abc123")).not.toThrow();
  });
});

describe("generatePublishableKey", () => {
  it("always starts with pk_ and is never confusable with an sk_ key", () => {
    const key = generatePublishableKey();
    expect(key.startsWith("pk_")).toBe(true);
    expect(() => assertNotSecretKey(key)).not.toThrow();
  });
});

describe("getOrCreateEmbedConfig / resolveEmbedKey / rotatePublishableKey", () => {
  it("provisions a config with an empty allowlist, resolvable by its own key, and logs an audit entry", async () => {
    const merchant = await createTestMerchant("embed-test-provision");
    cleanupMerchantIds.push(merchant.id);

    const config = await getOrCreateEmbedConfig(merchant.id);
    expect(config.publishableKey.startsWith("pk_")).toBe(true);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.status).toBe("active");

    const resolved = await resolveEmbedKey(config.publishableKey);
    expect(resolved?.merchantId).toBe(merchant.id);

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.merchantId, merchant.id));
    expect(entry?.event).toBe("embed_config_provisioned");
  });

  it("is idempotent — a second call returns the same key, not a new one", async () => {
    const merchant = await createTestMerchant("embed-test-idempotent");
    cleanupMerchantIds.push(merchant.id);

    const first = await getOrCreateEmbedConfig(merchant.id);
    const second = await getOrCreateEmbedConfig(merchant.id);
    expect(second.publishableKey).toBe(first.publishableKey);
  });

  it("resolveEmbedKey returns null for an unknown key", async () => {
    expect(await resolveEmbedKey("pk_does_not_exist")).toBeNull();
  });

  it("resolveEmbedKey returns null for a disabled embed", async () => {
    const merchant = await createTestMerchant("embed-test-disabled");
    cleanupMerchantIds.push(merchant.id);

    const config = await getOrCreateEmbedConfig(merchant.id);
    await db.update(schema.embedConfigs).set({ status: "disabled" }).where(eq(schema.embedConfigs.merchantId, merchant.id));

    expect(await resolveEmbedKey(config.publishableKey)).toBeNull();
  });

  it("rotatePublishableKey issues a new key and invalidates the old one", async () => {
    const merchant = await createTestMerchant("embed-test-rotate");
    cleanupMerchantIds.push(merchant.id);

    const original = await getOrCreateEmbedConfig(merchant.id);
    const rotated = await rotatePublishableKey(merchant.id);

    expect(rotated.publishableKey).not.toBe(original.publishableKey);
    expect(await resolveEmbedKey(original.publishableKey)).toBeNull();
    expect((await resolveEmbedKey(rotated.publishableKey))?.merchantId).toBe(merchant.id);
  });
});
