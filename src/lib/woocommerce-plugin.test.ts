import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { generateWooCommercePlugin, generateWooCommercePluginForMerchant } from "@/lib/woocommerce-plugin";

const cleanupMerchantIds: string[] = [];

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const id = cleanupMerchantIds.pop()!;
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, id));
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

describe("generateWooCommercePlugin", () => {
  const opts = {
    merchantId: "11111111-1111-1111-1111-111111111111",
    merchantName: "Test Store",
    publishableKey: "pk_abc123",
    appOrigin: "https://example.com",
  };

  it("carries no secret — only the publishable key, never an sk_-prefixed value or anything else", () => {
    const content = generateWooCommercePlugin(opts);
    expect(content).toContain("pk_abc123");
    expect(content).not.toMatch(/\bsk_[a-zA-Z0-9_-]+/);
    expect(content).not.toContain("RAZORPAY");
    expect(content).not.toContain("password");
  });

  it("is byte-identical across two generations for the same merchant", () => {
    const first = generateWooCommercePlugin(opts);
    const second = generateWooCommercePlugin(opts);
    expect(first).toBe(second);
  });

  it("differs when the publishable key differs (proves the key is actually baked in, not a placeholder)", () => {
    const a = generateWooCommercePlugin(opts);
    const b = generateWooCommercePlugin({ ...opts, publishableKey: "pk_different" });
    expect(a).not.toBe(b);
    expect(b).toContain("pk_different");
  });

  it("registers activation and deactivation hooks, both flushing rewrite rules — idempotent and clean removal", () => {
    const content = generateWooCommercePlugin(opts);
    expect(content).toContain("register_activation_hook");
    expect(content).toContain("register_deactivation_hook");
    const flushCount = (content.match(/flush_rewrite_rules\(\)/g) ?? []).length;
    expect(flushCount).toBe(2);
  });

  it("proxies the discovery document from the real live manifest rather than embedding a static copy", () => {
    const content = generateWooCommercePlugin(opts);
    expect(content).toContain("agent-commerce.json");
    expect(content).toContain("/store/");
    expect(content).toContain("manifest.json");
    expect(content).toContain("wp_remote_get");
  });

  it("adds Product structured data from the real WooCommerce product object, not a fabricated value", () => {
    const content = generateWooCommercePlugin(opts);
    expect(content).toContain("schema.org/");
    expect(content).toContain('@type');
    expect(content).toContain("$product->get_price()");
    expect(content).toContain("$product->get_sku()");
    expect(content).not.toMatch(/'price'\s*=>\s*['"0-9]/); // never a literal price, only the live getter
  });

  it("escapes a merchant name containing a PHP string-breaking character", () => {
    const content = generateWooCommercePlugin({ ...opts, merchantName: "Bob's \"Great\" Store" });
    expect(content).toContain("Bob\\'s");
  });
});

describe("generateWooCommercePluginForMerchant", () => {
  it("uses the merchant's real embed config and audits the generation", async () => {
    const merchant = await createTestMerchant("WooCommerce Test Merchant");
    cleanupMerchantIds.push(merchant.id);

    const { filename, content } = await generateWooCommercePluginForMerchant(merchant.id, merchant.name);
    expect(filename).toBe("thirdman-agent-commerce.php");
    expect(content).toContain(merchant.id);

    const [config] = await db.select().from(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchant.id));
    expect(config).toBeDefined();
    expect(content).toContain(config!.publishableKey);

    const logRows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.merchantId, merchant.id));
    expect(logRows.some((r) => r.event === "woocommerce_plugin_generated")).toBe(true);
  });
});
