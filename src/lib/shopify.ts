import { randomBytes } from "crypto";
import { eq, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env, getAppUrl } from "@/lib/env";
import { encrypt, decrypt } from "@/lib/crypto";
import { logAuditEntry } from "@/lib/audit";
import { importCatalogueRows, MAX_IMPORT_ROWS, type ImportRowPreview } from "@/lib/catalogue-import";
import { getOrCreateEmbedConfig } from "@/lib/embed";

/**
 * Layer 24-3: the Shopify app. A real OAuth2 install flow against a
 * merchant's own shop, an Admin API client, and a catalogue sync that
 * lands in the exact same preview-then-confirm pipeline every other
 * import source uses (catalogue-import.ts) — a new source, not a new
 * write path, per the plan's own instruction.
 *
 * Scoping honesty (see DECISIONS.md): this is built and exercised as a
 * custom/unlisted app installed directly on a real Shopify development
 * store, which needs no App Store review and runs the identical OAuth,
 * Admin API and webhook code any listed app would. A public listing is
 * a separate, later review step this project has not taken.
 *
 * Only three product-level read scopes are ever requested — this app
 * reads a merchant's catalogue, it never writes back to Shopify or
 * touches an order.
 */

const SCOPES = "read_products";
const STATE_TTL_MS = 10 * 60 * 1000;
const API_VERSION = "2025-01";

/**
 * Every real Shopify shop is HTTPS-only — this is not configurable in
 * production. The one exception is a loopback address, which exists
 * solely so shopify.test.ts can stand up a real local HTTP server in
 * place of Shopify's own endpoints (this codebase's standing no-mocks
 * convention — see store-fetch.test.ts) rather than mocking fetch().
 * isValidShopDomain() rejects a loopback address as an *install input*
 * regardless, so this can never be reached from a real merchant flow.
 */
function shopBaseUrl(shopDomain: string): string {
  const isLoopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(shopDomain);
  return `${isLoopback ? "http" : "https"}://${shopDomain}`;
}

export function isShopifyConfigured(): boolean {
  return !!env.SHOPIFY_API_KEY && !!env.SHOPIFY_API_SECRET;
}

/** "my-store.myshopify.com" only — the one shape Shopify's own install links use. Rejects anything else outright rather than attempting to normalize a merchant-typed URL, since a wrong shop domain would send a merchant to a stranger's OAuth consent screen. */
export function isValidShopDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain.trim().toLowerCase());
}

function redirectUri(): string {
  return `${getAppUrl()}/api/shopify/callback`;
}

/**
 * Starts the install: mints a single-use state row (not a cookie — see
 * schema.ts's shopifyInstallStates comment on why a row survives the
 * round trip through the merchant's own Shopify admin, which a
 * same-origin cookie can't be relied on to) and returns the shop's own
 * authorize URL.
 */
export async function beginShopifyInstall(merchantId: string, shopDomain: string): Promise<string> {
  if (!env.SHOPIFY_API_KEY) {
    throw new Error("shopify: SHOPIFY_API_KEY is not configured");
  }
  if (!isValidShopDomain(shopDomain)) {
    throw new Error(`shopify: "${shopDomain}" is not a valid *.myshopify.com domain`);
  }

  const state = randomBytes(32).toString("hex");
  await db.insert(schema.shopifyInstallStates).values({
    state,
    merchantId,
    shopDomain,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const params = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });

  return `${shopBaseUrl(shopDomain)}/admin/oauth/authorize?${params.toString()}`;
}

export type ShopifyInstallResult =
  | { outcome: "connected"; merchantId: string; shopDomain: string }
  | { outcome: "invalid_state" }
  | { outcome: "shop_already_connected" };

/**
 * Completes the install: redeems and deletes the state row (single-use,
 * same discipline as cliLinkTokens), exchanges the code for an offline
 * access token, and stores it encrypted. A shop already connected to a
 * different merchant is refused rather than silently reassigned — the
 * unique index on shopDomain is the backstop, this is the readable
 * refusal in front of it.
 */
export async function completeShopifyInstall(shopDomain: string, code: string, state: string): Promise<ShopifyInstallResult> {
  const [stateRow] = await db.select().from(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.state, state));

  if (stateRow) {
    await db.delete(schema.shopifyInstallStates).where(eq(schema.shopifyInstallStates.state, state));
  }

  if (!stateRow || stateRow.shopDomain !== shopDomain || stateRow.expiresAt.getTime() < Date.now()) {
    return { outcome: "invalid_state" };
  }

  const [existingForShop] = await db.select().from(schema.shopifyConnections).where(eq(schema.shopifyConnections.shopDomain, shopDomain));
  if (existingForShop && existingForShop.merchantId !== stateRow.merchantId) {
    return { outcome: "shop_already_connected" };
  }

  const accessToken = await exchangeCodeForAccessToken(shopDomain, code);

  await db
    .insert(schema.shopifyConnections)
    .values({
      merchantId: stateRow.merchantId,
      shopDomain,
      accessTokenEncrypted: encrypt(accessToken),
      scope: SCOPES,
    })
    .onConflictDoUpdate({
      target: schema.shopifyConnections.merchantId,
      set: { shopDomain, accessTokenEncrypted: encrypt(accessToken), scope: SCOPES, installedAt: new Date() },
    });

  await logAuditEntry({
    merchantId: stateRow.merchantId,
    actor: "merchant",
    event: "shopify_connected",
    decision: "n/a",
    reason: `Merchant connected Shopify store ${shopDomain} via OAuth install.`,
  });

  return { outcome: "connected", merchantId: stateRow.merchantId, shopDomain };
}

async function exchangeCodeForAccessToken(shopDomain: string, code: string): Promise<string> {
  if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
    throw new Error("shopify: app is not configured");
  }

  const res = await fetch(`${shopBaseUrl(shopDomain)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code,
    }),
  });

  if (!res.ok) {
    throw new Error(`shopify: token exchange failed with status ${res.status}`);
  }

  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("shopify: token exchange returned no access_token");
  }
  return body.access_token;
}

export interface ShopifyConnection {
  shopDomain: string;
  scope: string;
  installedAt: Date;
  lastSyncedAt: Date | null;
}

export async function getShopifyConnection(merchantId: string): Promise<ShopifyConnection | null> {
  const [row] = await db.select().from(schema.shopifyConnections).where(eq(schema.shopifyConnections.merchantId, merchantId));
  if (!row) return null;
  return { shopDomain: row.shopDomain, scope: row.scope, installedAt: row.installedAt, lastSyncedAt: row.lastSyncedAt };
}

export async function disconnectShopify(merchantId: string): Promise<void> {
  const existing = await getShopifyConnection(merchantId);
  if (!existing) return;

  await db.delete(schema.shopifyConnections).where(eq(schema.shopifyConnections.merchantId, merchantId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "shopify_disconnected",
    decision: "n/a",
    reason: `Merchant disconnected Shopify store ${existing.shopDomain}.`,
  });
}

interface ShopifyAdminProduct {
  id: number;
  title: string;
  body_html: string | null;
  variants: Array<{
    id: number;
    sku: string | null;
    price: string;
    inventory_quantity: number | null;
  }>;
}

interface ShopifyProductsResponse {
  products: ShopifyAdminProduct[];
}

/** Strips HTML tags from Shopify's body_html — a merchant's product description is rich text there, but catalogue-import.ts's rows are a plain description field, same as the CSV path already assumes. */
function stripHtml(html: string | null): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Fetches a bounded page of the shop's real product catalogue via the
 * Admin API's REST product listing, respecting MAX_IMPORT_ROWS the same
 * way the CSV path does — a merchant with more products than that gets
 * an honestly partial preview (isTruncated: true) rather than a silent
 * cut, matching L24-3's own "paginated, honest handling" requirement.
 * Shopify's per-app rate limit is respected by requesting the API's
 * documented per-page maximum in one call rather than looping past
 * MAX_IMPORT_ROWS at all.
 */
export async function fetchShopifyCatalogue(merchantId: string): Promise<{ rows: ImportRowPreview[]; isTruncated: boolean }> {
  const connection = await db.select().from(schema.shopifyConnections).where(eq(schema.shopifyConnections.merchantId, merchantId));
  const row = connection[0];
  if (!row) {
    throw new Error("shopify: no connection for this merchant");
  }

  const accessToken = decrypt(row.accessTokenEncrypted);
  const perPage = Math.min(MAX_IMPORT_ROWS, 250); // Shopify's own documented REST page-size ceiling.

  const res = await fetch(`${shopBaseUrl(row.shopDomain)}/admin/api/${API_VERSION}/products.json?limit=${perPage}`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });

  if (!res.ok) {
    throw new Error(`shopify: product fetch failed with status ${res.status}`);
  }

  const body = (await res.json()) as ShopifyProductsResponse;
  const isTruncated = body.products.length >= perPage;

  const seenSkus = new Set<string>();
  const rows: ImportRowPreview[] = [];

  for (const product of body.products) {
    for (const variant of product.variants) {
      if (rows.length >= MAX_IMPORT_ROWS) break;

      const sku = (variant.sku ?? "").trim() || `SHOPIFY-${variant.id}`;
      const priceRupees = Number(variant.price);
      const stock = variant.inventory_quantity ?? 0;

      let error: string | null = null;
      if (!product.title.trim()) error = "Missing name";
      else if (!Number.isFinite(priceRupees) || priceRupees < 0) error = "Price is missing or not a valid amount";
      else if (seenSkus.has(sku)) error = "Duplicate SKU within this store's catalogue";

      if (!error) seenSkus.add(sku);

      rows.push({
        name: product.title.trim(),
        description: stripHtml(product.body_html),
        sku,
        priceRupees: Number.isFinite(priceRupees) ? priceRupees : 0,
        costRupees: 0, // Shopify's REST product API doesn't expose cost — the merchant's real margin stays theirs to enter, never guessed.
        stock: stock >= 0 ? stock : 0,
        error,
      });
    }
  }

  return { rows, isTruncated };
}

/**
 * Writes a merchant-confirmed Shopify catalogue preview through the
 * exact same importCatalogueRows write path csv/pasted_text already use
 * — this function is a source, not a second writer. Stamps
 * lastSyncedAt so /dashboard/integrations can show a real "synced 4
 * minutes ago" rather than an assumed-fresh state.
 */
export async function confirmShopifySync(merchantId: string, rows: ImportRowPreview[]) {
  const result = await importCatalogueRows(merchantId, "shopify", rows);

  await db.update(schema.shopifyConnections).set({ lastSyncedAt: new Date() }).where(eq(schema.shopifyConnections.merchantId, merchantId));

  return result;
}

/**
 * The theme app extension's install surface: a Shopify theme app
 * extension has no server-generated file to download (unlike the
 * WooCommerce plugin) — it's a block the merchant adds via their own
 * theme editor, which is Shopify's own reviewed, sandboxed UI for doing
 * exactly that. This returns the widget's real, already-provisioned
 * publishable key so the dashboard can show the merchant the one value
 * the extension's settings panel needs, never a secret.
 */
export async function getShopifyWidgetConfig(merchantId: string): Promise<{ publishableKey: string; appOrigin: string }> {
  const embedConfig = await getOrCreateEmbedConfig(merchantId);
  return { publishableKey: embedConfig.publishableKey, appOrigin: getAppUrl() };
}

/** Same shape as cli-link.ts's sweepExpiredCliLinkTokens — an abandoned install (the merchant closed the tab on Shopify's consent screen) leaves an expired, single-use state row that's otherwise never cleaned up. Registered in /api/cron/run. */
export async function sweepExpiredShopifyInstallStates(): Promise<{ swept: number }> {
  const deleted = await db.delete(schema.shopifyInstallStates).where(lt(schema.shopifyInstallStates.expiresAt, new Date())).returning({ state: schema.shopifyInstallStates.state });
  return { swept: deleted.length };
}
