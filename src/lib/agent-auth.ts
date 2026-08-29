import { createHash, randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Authenticates an agent API request by its raw key against the stored
 * hash. Unauthenticated requests never reach the gate. Returns null on
 * any failure, revoked or not, so the caller can respond uniformly
 * without leaking which failure mode occurred.
 */
export async function authenticateAgent(
  rawKey: string | null,
): Promise<typeof schema.agents.$inferSelect | null> {
  if (!rawKey) return null;

  const apiKeyHash = hashApiKey(rawKey);
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.apiKeyHash, apiKeyHash));

  return agent ?? null;
}

type AgentCapability = (typeof schema.agentCapabilityEnum.enumValues)[number];

/**
 * Layer 13-2: authentication is not authorization. An authenticated,
 * unrevoked, under-cap agent is not automatically authorized for
 * everything the API exposes — it must hold the specific capability a
 * route or MCP tool requires. A capability not granted is denied; there
 * is no admin/superuser bypass. Refunds and payouts are deliberately not
 * in agentCapabilityEnum at all, so no capability check could ever grant
 * them — see DECISIONS.md.
 *
 * Every denial writes an agent_capability_denied audit entry naming the
 * missing scope and returns false — the caller (a route handler or MCP
 * tool) turns that into a 403 or an honest tool-result refusal, never a
 * silent no-op or a 500.
 */
export async function requireCapability(
  agent: typeof schema.agents.$inferSelect,
  capability: AgentCapability,
): Promise<boolean> {
  const [grant] = await db
    .select({ capability: schema.agentCapabilities.capability })
    .from(schema.agentCapabilities)
    .where(and(eq(schema.agentCapabilities.agentId, agent.id), eq(schema.agentCapabilities.capability, capability)));

  if (grant) return true;

  await logAuditEntry({
    merchantId: agent.merchantId,
    actor: "agent",
    event: "agent_capability_denied",
    decision: "deny",
    reason: `Denied — agent "${agent.name}" does not hold the "${capability}" capability. Authentication alone does not grant authorization.`,
    boundApplied: `agent_capability:${capability}`,
    metadata: { agentId: agent.id, capability },
  });

  return false;
}

/** Every capability granted to an agent, for the dashboard's checkbox UI and MCP tool gating. */
export async function getAgentCapabilities(agentId: string): Promise<AgentCapability[]> {
  const rows = await db.select({ capability: schema.agentCapabilities.capability }).from(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agentId));
  return rows.map((r) => r.capability);
}

/** Extracts the raw agent key from the Authorization header, expecting "Bearer <key>". */
export function extractBearerKey(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim() || null;
}

/** SHA-256 hash of a raw agent key, as stored in agents.api_key_hash. The only place this hashing scheme is defined. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Generates a new raw agent API key. Never persisted — only its hash is stored. */
export function generateApiKey(): string {
  return `sk_${randomBytes(24).toString("base64url")}`;
}
