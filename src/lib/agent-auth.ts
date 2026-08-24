import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

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

  const apiKeyHash = createHash("sha256").update(rawKey).digest("hex");
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.apiKeyHash, apiKeyHash));

  return agent ?? null;
}

/** Extracts the raw agent key from the Authorization header, expecting "Bearer <key>". */
export function extractBearerKey(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim() || null;
}
