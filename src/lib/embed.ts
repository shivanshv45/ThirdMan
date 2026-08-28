import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Resolves the embeddable widget's publishable key to a merchant and
 * decides whether a given browser Origin is allowed to use it. This is
 * the only module that reads/writes embed_configs — everything else
 * (the loader route, the CORS layer, the dashboard) imports from here.
 *
 * Read plans/layer-10-embeddable-commerce.md's L10-1 before changing
 * this file: the key format and the allow/deny rules here are a public
 * contract once a merchant has pasted a snippet using them.
 */

export type EmbedConfig = typeof schema.embedConfigs.$inferSelect;

const PUBLISHABLE_KEY_PREFIX = "pk_";
const SECRET_KEY_PREFIX = "sk_";

/** Generates a new publishable key. Safe to display repeatedly — see embed_configs.publishableKey's schema comment for why this isn't hashed. */
export function generatePublishableKey(): string {
  return `${PUBLISHABLE_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

/**
 * Rejects a value shaped like an agent secret key wherever an embed key
 * is expected — the failure mode this guards against is a merchant
 * pasting an "sk_..." agent key into public HTML, or a future caller
 * assuming the two prefixes are interchangeable. They are not: sk_ is
 * hashed and never re-displayed, pk_ is plaintext and safe to show
 * repeatedly. See ARCHITECTURE.md's "The embeddable widget".
 */
export function assertNotSecretKey(value: string): void {
  if (value.startsWith(SECRET_KEY_PREFIX)) {
    throw new Error(
      `This looks like an agent secret key (starts with "${SECRET_KEY_PREFIX}"), not an embed publishable key. Agent keys authenticate a server-side AI buyer and must never be pasted into a public web page. Use the "${PUBLISHABLE_KEY_PREFIX}" key from /dashboard/embed instead.`,
    );
  }
}

export async function getEmbedConfig(merchantId: string): Promise<EmbedConfig | null> {
  const [config] = await db.select().from(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchantId));
  return config ?? null;
}

/**
 * Resolves a raw publishable key to its config. Returns null for an
 * unknown key or one whose embed is disabled — callers get a uniform
 * "not usable" signal without needing to distinguish why, same pattern
 * as agent-auth.ts's authenticateAgent.
 */
export async function resolveEmbedKey(publishableKey: string): Promise<EmbedConfig | null> {
  if (!publishableKey || !publishableKey.startsWith(PUBLISHABLE_KEY_PREFIX)) return null;

  const [config] = await db
    .select()
    .from(schema.embedConfigs)
    .where(eq(schema.embedConfigs.publishableKey, publishableKey));

  if (!config || config.status === "disabled") return null;
  return config;
}

/**
 * Normalises a browser Origin (or a merchant-entered domain) to
 * scheme://host[:port], lowercase host, no trailing slash, no path.
 * Returns null for anything that doesn't parse as an http(s) origin —
 * garbage is rejected at the write boundary, never stored as-is, so the
 * runtime check in isOriginAllowed can stay a plain string comparison.
 */
export function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A merchant may type "shop.example.com" without a scheme — treat
  // that as https. Any OTHER scheme (ftp://, javascript:, etc) is
  // rejected outright below rather than blindly prefixed, which would
  // otherwise turn "ftp://host" into the nonsensical "https://ftp://host".
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
}

/**
 * The origin bound — deterministic code, no fuzzy matching, no model.
 * An empty allowlist denies (fail closed: "not configured" is never
 * "allow everything"). A missing Origin header denies. Everything else
 * is exact string equality against the normalised allowlist.
 *
 * No wildcard support: exact origins only. A merchant with several
 * subdomains lists several origins — see DECISIONS.md for why a
 * wildcard was left out rather than half-built.
 */
export function isOriginAllowed(config: Pick<EmbedConfig, "allowedOrigins" | "status">, requestOrigin: string | null): boolean {
  if (config.status === "disabled") return false;
  if (!requestOrigin) return false;
  if (config.allowedOrigins.length === 0) return false;

  const normalizedRequest = normalizeOrigin(requestOrigin);
  if (!normalizedRequest) return false;

  return config.allowedOrigins.includes(normalizedRequest);
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Validates a merchant-supplied accent colour before it ever reaches storage or a stylesheet. A CSS custom property fed an unvalidated string is a CSS injection. */
export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value.trim());
}

/**
 * Provisions this merchant's embed config on first use. A real
 * merchant-initiated act (a dashboard page load or an explicit
 * "Generate embed key" action), logged like any other setup event —
 * see storefront.ts's getOrCreateStorefrontAgent for the pattern this
 * mirrors.
 */
export async function getOrCreateEmbedConfig(merchantId: string): Promise<EmbedConfig> {
  const existing = await getEmbedConfig(merchantId);
  if (existing) return existing;

  const [config] = await db
    .insert(schema.embedConfigs)
    .values({
      merchantId,
      publishableKey: generatePublishableKey(),
    })
    .onConflictDoNothing({ target: schema.embedConfigs.merchantId })
    .returning();

  // A concurrent request may have won the insert race — re-read rather
  // than assume `config` exists, mirroring the gate's own
  // idempotency-race handling (see gate contract point 7).
  const resolved = config ?? (await getEmbedConfig(merchantId));
  if (!resolved) throw new Error(`Failed to provision embed config for merchant ${merchantId}`);

  if (config) {
    await logAuditEntry({
      merchantId,
      actor: "merchant",
      event: "embed_config_provisioned",
      decision: "n/a",
      reason: "Generated the embeddable widget's publishable key on first use. The widget will not run on any site until at least one allowed origin is added.",
      metadata: { publishableKeyTail: resolved.publishableKey.slice(-6) },
    });
  }

  return resolved;
}

/** Rotates a merchant's publishable key in place — same row, new key, origins and config untouched. Breaks every site still running the old snippet; the caller must say so in the UI. */
export async function rotatePublishableKey(merchantId: string): Promise<EmbedConfig> {
  const fresh = generatePublishableKey();
  const [config] = await db
    .update(schema.embedConfigs)
    .set({ publishableKey: fresh, updatedAt: new Date() })
    .where(eq(schema.embedConfigs.merchantId, merchantId))
    .returning();

  if (!config) throw new Error(`No embed config to rotate for merchant ${merchantId}`);

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "embed_key_rotated",
    decision: "n/a",
    reason: "Rotated the embeddable widget's publishable key. Every site still using the previous key's snippet will stop working until updated.",
    metadata: { publishableKeyTail: fresh.slice(-6) },
  });

  return config;
}
