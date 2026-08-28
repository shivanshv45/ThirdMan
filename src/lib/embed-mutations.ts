import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { getOrCreateEmbedConfig, isValidHexColor, normalizeOrigin, rotatePublishableKey } from "@/lib/embed";

/**
 * Dashboard-facing mutations for /dashboard/embed. Follows
 * dashboard-mutations.ts's own split: framework-agnostic logic here,
 * thin Server Action wrappers in src/app/dashboard/embed/actions.ts.
 */

export interface UpdateEmbedOriginsInput {
  merchantId: string;
  origins: string[];
}

/** Replaces the full allowlist. Every entry is normalised and invalid entries are rejected loudly rather than silently dropped — a merchant needs to know a domain they typed didn't take. */
export async function updateEmbedOrigins(input: UpdateEmbedOriginsInput) {
  await getOrCreateEmbedConfig(input.merchantId);

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of input.origins) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const norm = normalizeOrigin(trimmed);
    if (!norm) throw new Error(`"${trimmed}" is not a valid origin (expected something like https://shop.example.com)`);
    if (!seen.has(norm)) {
      seen.add(norm);
      normalized.push(norm);
    }
  }

  const [config] = await db
    .update(schema.embedConfigs)
    .set({ allowedOrigins: normalized, updatedAt: new Date() })
    .where(eq(schema.embedConfigs.merchantId, input.merchantId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "embed_origins_updated",
    decision: "n/a",
    reason:
      normalized.length === 0
        ? "Merchant cleared the embed's allowed origins. The widget will refuse to load on any site until at least one origin is added back."
        : `Merchant set the embed's allowed origins to: ${normalized.join(", ")}.`,
    metadata: { origins: normalized },
  });

  return config;
}

export interface UpdateEmbedAppearanceInput {
  merchantId: string;
  displayName: string | null;
  accentColor: string | null;
  greeting: string | null;
  position: "bottom_right" | "bottom_left";
  negotiationEnabled: boolean;
  offersEnabled: boolean;
}

export async function updateEmbedAppearance(input: UpdateEmbedAppearanceInput) {
  await getOrCreateEmbedConfig(input.merchantId);

  const accentColor = input.accentColor?.trim() || null;
  if (accentColor && !isValidHexColor(accentColor)) {
    throw new Error(`"${accentColor}" is not a valid hex colour (expected e.g. #1a8f5e)`);
  }

  const [config] = await db
    .update(schema.embedConfigs)
    .set({
      displayName: input.displayName?.trim() || null,
      accentColor,
      greeting: input.greeting?.trim() || null,
      position: input.position,
      features: { negotiation: input.negotiationEnabled, offers: input.offersEnabled },
      updatedAt: new Date(),
    })
    .where(eq(schema.embedConfigs.merchantId, input.merchantId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "embed_appearance_updated",
    decision: "n/a",
    reason: "Merchant updated the embedded widget's appearance (display name, colour, greeting, or position).",
  });

  return config;
}

export async function setEmbedStatus(merchantId: string, status: "active" | "disabled") {
  await getOrCreateEmbedConfig(merchantId);

  const [config] = await db
    .update(schema.embedConfigs)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.embedConfigs.merchantId, merchantId))
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: status === "disabled" ? "embed_disabled" : "embed_enabled",
    decision: "n/a",
    reason:
      status === "disabled"
        ? "Merchant disabled the embeddable widget. Every site using its snippet will stop loading it until re-enabled — /store/[merchantId] is unaffected."
        : "Merchant re-enabled the embeddable widget.",
  });

  return config;
}

export async function rotateEmbedKey(merchantId: string) {
  await getOrCreateEmbedConfig(merchantId);
  return rotatePublishableKey(merchantId);
}
