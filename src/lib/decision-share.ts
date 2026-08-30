import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 25-4: an explicit, revocable, unguessable token letting one
 * specific decision be viewed at /why/[id] outside the dashboard — a
 * decision is not public data by default (per
 * plans/layer-25-control-surfaces.md), so /why/[id] itself is
 * merchant-session-scoped and this is the ONLY way to make one
 * decision visible without a session. Scoped to a single audit_log row;
 * revoking deletes the token, never the underlying decision.
 */

/** Generates a new opaque share token. Never derived from the audit_log id itself, so a token can't be guessed from a decision id a merchant already has. */
function generateShareToken(): string {
  return `share_${randomBytes(24).toString("base64url")}`;
}

export async function createDecisionShareToken(merchantId: string, auditLogId: string): Promise<string> {
  const [row] = await db.select({ id: schema.auditLog.id }).from(schema.auditLog).where(and(eq(schema.auditLog.id, auditLogId), eq(schema.auditLog.merchantId, merchantId)));
  if (!row) throw new Error("Decision not found");

  const token = generateShareToken();
  await db.insert(schema.decisionShareTokens).values({ token, merchantId, auditLogId });

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "decision_share_created",
    decision: "n/a",
    reason: `Merchant created a shareable link for decision ${auditLogId.slice(0, 8)}.`,
    metadata: { auditLogId },
  });

  return token;
}

export async function revokeDecisionShareToken(merchantId: string, token: string): Promise<void> {
  const deleted = await db
    .delete(schema.decisionShareTokens)
    .where(and(eq(schema.decisionShareTokens.token, token), eq(schema.decisionShareTokens.merchantId, merchantId)))
    .returning({ auditLogId: schema.decisionShareTokens.auditLogId });

  if (deleted.length === 0) return;

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "decision_share_revoked",
    decision: "n/a",
    reason: `Merchant revoked a shareable link for decision ${deleted[0].auditLogId.slice(0, 8)}.`,
    metadata: { auditLogId: deleted[0].auditLogId },
  });
}

/** Every active share token for one decision, for the dashboard to show/revoke. */
export async function getShareTokensForDecision(merchantId: string, auditLogId: string) {
  return db.select().from(schema.decisionShareTokens).where(and(eq(schema.decisionShareTokens.merchantId, merchantId), eq(schema.decisionShareTokens.auditLogId, auditLogId)));
}

/**
 * Resolves a public share token back to the (merchantId, auditLogId) it
 * grants access to — the ONLY lookup a public /why/[id]?share=<token>
 * request may use in place of a merchant session. Returns null on any
 * miss, deliberately indistinguishable from a wrong id: id enumeration
 * must fail closed the same way isolation.test.ts already requires
 * elsewhere in this codebase.
 */
export async function resolveShareToken(token: string): Promise<{ merchantId: string; auditLogId: string } | null> {
  const [row] = await db.select({ merchantId: schema.decisionShareTokens.merchantId, auditLogId: schema.decisionShareTokens.auditLogId }).from(schema.decisionShareTokens).where(eq(schema.decisionShareTokens.token, token));
  return row ?? null;
}
