import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { updateEmbedOrigins } from "@/lib/embed-mutations";
import { proxy } from "@/proxy";

/**
 * Layer 26-4: proves the embed's per-merchant frame-ancestors CSP
 * (proxy.ts) still composes correctly once next.config.ts's own,
 * unrelated CSP exists — "these two must not fight" from
 * plans/layer-26-hardening.md. security-headers.test.ts already proves
 * next.config.ts defines no CSP rule matching /embed at all, so this
 * test proves the other half directly against the real proxy(): the
 * /embed response's Content-Security-Policy is exactly proxy.ts's own
 * frame-ancestors value, for both an allowed and a denied origin, and
 * it is real per-merchant data, not a static default.
 */

const cleanupMerchantIds: string[] = [];

afterEach(async () => {
  while (cleanupMerchantIds.length) {
    const id = cleanupMerchantIds.pop()!;
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  }
});

describe("proxy() embed CSP composition", () => {
  it("sets frame-ancestors to the merchant's real allowed origins, and nothing else", async () => {
    const merchant = await createTestMerchant("embed-headers-compose-test");
    cleanupMerchantIds.push(merchant.id);
    const config = await getOrCreateEmbedConfig(merchant.id);
    await updateEmbedOrigins({ merchantId: merchant.id, origins: ["https://merchant-site.example"] });

    const req = new NextRequest(new URL(`http://localhost/embed/${config.publishableKey}`));
    const res = await proxy(req);

    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe("frame-ancestors https://merchant-site.example;");
  });

  it("fails closed to frame-ancestors 'none' for an unknown embed key", async () => {
    const req = new NextRequest(new URL("http://localhost/embed/pk_this_key_does_not_exist"));
    const res = await proxy(req);

    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe("frame-ancestors 'none';");
  });

  it("is per-merchant — two merchants with different allowed origins get different frame-ancestors values", async () => {
    const merchantA = await createTestMerchant("embed-headers-compose-test-a");
    const merchantB = await createTestMerchant("embed-headers-compose-test-b");
    cleanupMerchantIds.push(merchantA.id, merchantB.id);

    const configA = await getOrCreateEmbedConfig(merchantA.id);
    const configB = await getOrCreateEmbedConfig(merchantB.id);
    await updateEmbedOrigins({ merchantId: merchantA.id, origins: ["https://site-a.example"] });
    await updateEmbedOrigins({ merchantId: merchantB.id, origins: ["https://site-b.example"] });

    const resA = await proxy(new NextRequest(new URL(`http://localhost/embed/${configA.publishableKey}`)));
    const resB = await proxy(new NextRequest(new URL(`http://localhost/embed/${configB.publishableKey}`)));

    expect(resA.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://site-a.example;");
    expect(resB.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://site-b.example;");
  });
});
