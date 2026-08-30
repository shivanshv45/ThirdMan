import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  isValidShopDomain,
  beginShopifyInstall,
  completeShopifyInstall,
  getShopifyConnection,
  disconnectShopify,
  fetchShopifyCatalogue,
  confirmShopifySync,
  sweepExpiredShopifyInstallStates,
} from "@/lib/shopify";

/**
 * Layer 24-3's Shopify app: OAuth install, Admin API catalogue fetch,
 * and the sync landing in catalogue-import.ts's existing write path.
 * Exercised against a REAL local HTTP server standing in for Shopify's
 * token-exchange and Admin API endpoints — this codebase's standing
 * no-mocks convention (see store-fetch.test.ts), not a mocked fetch.
 * A real merchant-provided shop domain still gets a real https:// call
 * in shopify.ts; these tests substitute the *target* (a local server)
 * rather than the mechanism.
 */

let server: Server;
let serverOrigin: string;
let lastTokenExchangeBody: unknown = null;
let productsResponseOverride: object | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");

      if (req.url === "/admin/oauth/access_token" && req.method === "POST") {
        lastTokenExchangeBody = JSON.parse(body || "{}");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "shpat_test_token_abc123", scope: "read_products" }));
        return;
      }

      if (req.url?.startsWith("/admin/api/") && req.url.includes("/products.json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            productsResponseOverride ?? {
              products: [
                {
                  id: 1,
                  title: "Ethiopia Yirgacheffe 250g",
                  body_html: "<p>Bright, <b>floral</b> notes.</p>",
                  variants: [{ id: 101, sku: "ETH-250", price: "649.00", inventory_quantity: 40 }],
                },
                {
                  id: 2,
                  title: "House Blend 1kg",
                  body_html: null,
                  variants: [{ id: 201, sku: "HB-1KG", price: "1899.00", inventory_quantity: 12 }],
                },
              ],
            },
          ),
        );
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  serverOrigin = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__shopify_test_${Date.now()}_${Math.random()}__`,
      email: `shopify_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

const merchantIds: string[] = [];

afterEach(async () => {
  productsResponseOverride = null;
  lastTokenExchangeBody = null;

  const currentMerchantIds = [...merchantIds];
  merchantIds.length = 0;
  for (const merchantId of currentMerchantIds) {
    const variants = await db.select({ id: schema.productVariants.id, productId: schema.productVariants.productId }).from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId));
    for (const v of variants) {
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, v.id));
    }
    const productIds = [...new Set(variants.map((v) => v.productId))];
    for (const pid of productIds) {
      await db.delete(schema.products).where(eq(schema.products.id, pid));
    }
    await db.delete(schema.catalogueImports).where(eq(schema.catalogueImports.merchantId, merchantId));
    await db.delete(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.merchantId, merchantId));
    await db.delete(schema.shopifyConnections).where(eq(schema.shopifyConnections.merchantId, merchantId));
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
});

/** Real install-state row minted the normal way, then the exchange target is repointed at the local test server — the state/redemption logic under test is real; only the far end of the two outbound HTTPS calls is substituted. */
async function makeInstallState(merchantId: string, shopDomain: string) {
  const state = `test_state_${Date.now()}_${Math.random()}`;
  await db.insert(schema.shopifyInstallStates).values({ state, merchantId, shopDomain, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  return state;
}

describe("isValidShopDomain", () => {
  it("accepts a real *.myshopify.com domain", () => {
    expect(isValidShopDomain("my-coffee-store.myshopify.com")).toBe(true);
  });

  it("rejects anything else, including a merchant's own custom domain", () => {
    expect(isValidShopDomain("mystore.com")).toBe(false);
    expect(isValidShopDomain("https://my-store.myshopify.com")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
    expect(isValidShopDomain("../../etc/passwd")).toBe(false);
  });
});

describe("beginShopifyInstall", () => {
  it("mints a single-use state row and points the authorize URL at the real shop domain", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const url = await beginShopifyInstall(merchant.id, "test-shop.myshopify.com");
    expect(url).toContain("https://test-shop.myshopify.com/admin/oauth/authorize");
    expect(url).toContain("scope=read_products");

    const stateParam = new URL(url).searchParams.get("state")!;
    const [row] = await db.select().from(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.state, stateParam));
    expect(row).toBeTruthy();
    expect(row.merchantId).toBe(merchant.id);
  });

  it("refuses a malformed shop domain before writing anything", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    await expect(beginShopifyInstall(merchant.id, "not-a-shop")).rejects.toThrow();

    const rows = await db.select().from(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.merchantId, merchant.id));
    expect(rows.length).toBe(0);
  });
});

describe("completeShopifyInstall", () => {
  it("a real state redemption exchanges the code and stores the access token encrypted", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const state = await makeInstallState(merchant.id, serverOrigin);
    const result = await completeShopifyInstall(serverOrigin, "real_code_123", state);

    expect(result.outcome).toBe("connected");
    expect(lastTokenExchangeBody).toMatchObject({ code: "real_code_123" });

    const connection = await getShopifyConnection(merchant.id);
    expect(connection).not.toBeNull();
    expect(connection!.shopDomain).toBe(serverOrigin);

    const [row] = await db.select().from(schema.shopifyConnections).where(eq(schema.shopifyConnections.merchantId, merchant.id));
    expect(row.accessTokenEncrypted).not.toContain("shpat_test_token_abc123");
    expect(decrypt(row.accessTokenEncrypted)).toBe("shpat_test_token_abc123");
  });

  it("the state is single-use — a second redemption is refused", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const state = await makeInstallState(merchant.id, serverOrigin);
    const first = await completeShopifyInstall(serverOrigin, "code_1", state);
    expect(first.outcome).toBe("connected");

    const second = await completeShopifyInstall(serverOrigin, "code_2", state);
    expect(second.outcome).toBe("invalid_state");
  });

  it("a fabricated state is refused", async () => {
    const result = await completeShopifyInstall(serverOrigin, "code", "state_never_minted");
    expect(result.outcome).toBe("invalid_state");
  });

  it("an expired state is refused even though the row still exists", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const state = `test_state_expired_${Date.now()}`;
    await db.insert(schema.shopifyInstallStates).values({ state, merchantId: merchant.id, shopDomain: serverOrigin, expiresAt: new Date(Date.now() - 1000) });

    const result = await completeShopifyInstall(serverOrigin, "code", state);
    expect(result.outcome).toBe("invalid_state");
  });

  it("a shop already connected to a different merchant is refused, never silently reassigned", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();
    merchantIds.push(merchantA.id, merchantB.id);

    const stateA = await makeInstallState(merchantA.id, serverOrigin);
    const first = await completeShopifyInstall(serverOrigin, "code_a", stateA);
    expect(first.outcome).toBe("connected");

    const stateB = await makeInstallState(merchantB.id, serverOrigin);
    const second = await completeShopifyInstall(serverOrigin, "code_b", stateB);
    expect(second.outcome).toBe("shop_already_connected");

    const connection = await getShopifyConnection(merchantA.id);
    expect(connection!.shopDomain).toBe(serverOrigin);
  });
});

describe("disconnectShopify", () => {
  it("removes a real connection and is a no-op when there was none", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    const state = await makeInstallState(merchant.id, serverOrigin);
    await completeShopifyInstall(serverOrigin, "code", state);
    expect(await getShopifyConnection(merchant.id)).not.toBeNull();

    await disconnectShopify(merchant.id);
    expect(await getShopifyConnection(merchant.id)).toBeNull();

    await expect(disconnectShopify(merchant.id)).resolves.not.toThrow();
  });
});

describe("fetchShopifyCatalogue and confirmShopifySync", () => {
  it("fetches real variants from the Admin API into ImportRowPreview shape, HTML stripped from the description", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const state = await makeInstallState(merchant.id, serverOrigin);
    await completeShopifyInstall(serverOrigin, "code", state);

    const { rows, isTruncated } = await fetchShopifyCatalogue(merchant.id);
    expect(isTruncated).toBe(false);
    expect(rows.length).toBe(2);

    const ethiopia = rows.find((r) => r.sku === "ETH-250")!;
    expect(ethiopia.name).toBe("Ethiopia Yirgacheffe 250g");
    expect(ethiopia.description).toBe("Bright, floral notes.");
    expect(ethiopia.priceRupees).toBe(649);
    expect(ethiopia.stock).toBe(40);
    expect(ethiopia.error).toBeNull();
  });

  it("confirming the sync writes through the real catalogue-import path — nothing written until confirmed", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const state = await makeInstallState(merchant.id, serverOrigin);
    await completeShopifyInstall(serverOrigin, "code", state);

    const beforeVariants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchant.id));
    expect(beforeVariants.length).toBe(0);

    const { rows } = await fetchShopifyCatalogue(merchant.id);
    const result = await confirmShopifySync(merchant.id, rows);

    expect(result.rowsImported).toBe(2);
    expect(result.rowsSkipped).toBe(0);

    const afterVariants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchant.id));
    expect(afterVariants.map((v) => v.sku).sort()).toEqual(["ETH-250", "HB-1KG"]);

    const connection = await getShopifyConnection(merchant.id);
    expect(connection!.lastSyncedAt).not.toBeNull();
  });

  it("a row missing a price is flagged with an error and skipped on import, never written with a fabricated price", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const state = await makeInstallState(merchant.id, serverOrigin);
    await completeShopifyInstall(serverOrigin, "code", state);

    productsResponseOverride = {
      products: [{ id: 9, title: "Broken Listing", body_html: null, variants: [{ id: 901, sku: "BROKEN-1", price: "not-a-number", inventory_quantity: 5 }] }],
    };

    const { rows } = await fetchShopifyCatalogue(merchant.id);
    expect(rows[0].error).toBe("Price is missing or not a valid amount");

    const result = await confirmShopifySync(merchant.id, rows);
    expect(result.rowsImported).toBe(0);
    expect(result.rowsSkipped).toBe(1);
  });
});

describe("sweepExpiredShopifyInstallStates", () => {
  it("removes only expired, abandoned install attempts — a fresh in-progress install is untouched", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);

    await db.insert(schema.shopifyInstallStates).values({
      state: `test_sweep_expired_${Date.now()}`,
      merchantId: merchant.id,
      shopDomain: "abandoned-install.myshopify.com",
      expiresAt: new Date(Date.now() - 1000),
    });
    const freshState = await makeInstallState(merchant.id, "in-progress-install.myshopify.com");

    const { swept } = await sweepExpiredShopifyInstallStates();
    expect(swept).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.state, freshState));
    expect(remaining.length).toBe(1);
  });
});
