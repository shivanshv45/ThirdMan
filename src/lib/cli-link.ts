import { randomBytes } from "crypto";
import { eq, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { getOrCreateEmbedConfig, normalizeOrigin } from "@/lib/embed";

/**
 * Layer 20-6: the merchant CLI's account-linking token. A merchant
 * generates one on /dashboard/cli and pastes it into `thirdman init`'s
 * terminal prompt — this is the only credential that ever crosses into
 * the terminal, and it is scoped to nothing but "create one agent key
 * and offer one origin allowlist add," never a password or a session.
 * Single-use (deleted on redemption) and short-lived, same discipline
 * as decision-share.ts's tokens but consumed rather than left standing,
 * since this one grants a mutation rather than a read.
 */

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to paste, short enough to matter if leaked

function generateLinkToken(): string {
  return `cli_${randomBytes(24).toString("base64url")}`;
}

export async function createCliLinkToken(merchantId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateLinkToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(schema.cliLinkTokens).values({ token, merchantId, expiresAt });

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "cli_link_token_created",
    decision: "n/a",
    reason: "Merchant generated a CLI account-linking token for `thirdman init`, valid for 10 minutes and usable once.",
  });

  return { token, expiresAt };
}

export interface CliLinkResult {
  merchantId: string;
  merchantName: string;
  agentId: string;
  agentName: string;
  rawKey: string;
}

/**
 * Redeems a link token exactly once: deletes it (so a second use, or a
 * leaked copy, fails closed) then creates a new agent with the minimum
 * capability set that permits reading and purchasing — never the full
 * set, matching L20-6's stated default. Optionally adds the given origin
 * to the embed allowlist if the merchant confirmed it CLI-side.
 */
export async function redeemCliLinkToken(
  token: string,
  agentName: string,
  originToAllow: string | null,
): Promise<CliLinkResult | null> {
  const [row] = await db.delete(schema.cliLinkTokens).where(eq(schema.cliLinkTokens.token, token)).returning();
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, row.merchantId));
  if (!merchant) return null;

  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId: merchant.id,
      name: agentName.trim() || "CLI agent",
      apiKeyHash: hashApiKey(rawKey),
      status: "active",
    })
    .returning();

  await db.insert(schema.agentCapabilities).values([
    { agentId: agent.id, capability: "products:read" },
    { agentId: agent.id, capability: "purchase:create" },
  ]);

  await logAuditEntry({
    merchantId: merchant.id,
    actor: "merchant",
    event: "agent_created",
    decision: "n/a",
    reason: `Merchant linked the thirdman CLI, which created agent "${agent.name}" with capabilities products:read, purchase:create.`,
  });

  if (originToAllow) {
    const normalized = normalizeOrigin(originToAllow);
    if (normalized) {
      const config = await getOrCreateEmbedConfig(merchant.id);
      if (!config.allowedOrigins.includes(normalized)) {
        const updated = [...config.allowedOrigins, normalized];
        await db.update(schema.embedConfigs).set({ allowedOrigins: updated, updatedAt: new Date() }).where(eq(schema.embedConfigs.merchantId, merchant.id));

        await logAuditEntry({
          merchantId: merchant.id,
          actor: "merchant",
          event: "embed_origins_updated",
          decision: "n/a",
          reason: `Merchant used the thirdman CLI to add "${normalized}" (the site it detected) to the embed's allowed origins.`,
          metadata: { origins: updated },
        });
      }
    }
  }

  return { merchantId: merchant.id, merchantName: merchant.name, agentId: agent.id, agentName: agent.name, rawKey };
}

/** Registered in /api/cron/run alongside every other sweep — table hygiene for tokens nobody redeemed. */
export async function sweepExpiredCliLinkTokens(): Promise<{ swept: number }> {
  const deleted = await db.delete(schema.cliLinkTokens).where(lt(schema.cliLinkTokens.expiresAt, new Date())).returning({ token: schema.cliLinkTokens.token });
  return { swept: deleted.length };
}
