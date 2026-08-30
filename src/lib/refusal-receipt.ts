import { desc, eq } from "drizzle-orm";
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from "jose";
import { db, schema } from "@/lib/db";
import { getOrCreateMandateKeypair } from "@/lib/mandates";
import type { GateDecision, GateResult } from "@/lib/gate";

/**
 * Layer 21-6: the Refusal Receipt. A gate decision — allow, deny, or
 * escalate — turned into portable, verifiable evidence: a JWT signed
 * with the SAME merchant keypair mandates.ts already owns and already
 * publishes the public half of (L21-2). No second signing path, no
 * second key.
 *
 * The receipt asserts nothing the audit log doesn't already hold — it
 * is a signed VIEW over the audit_log row this exact decision already
 * wrote, found by moneyActionId when one exists, or (for a denial with
 * no money action at all — the request never got far enough to reserve
 * anything) by matching the merchant and the exact reason text just
 * logged. If no matching row can be found, issuing degrades to
 * undefined rather than fabricating content — see issueReceipt's own
 * comment.
 *
 * "We don't just refuse. We give you a receipt you can verify without
 * trusting us." Issued alongside the existing response body, never
 * replacing it — a caller that ignores the receipt sees exactly what it
 * saw before this layer.
 */

const ALG = "ES256";
const RECEIPT_TTL_SECONDS = 30 * 24 * 60 * 60; // long enough for a buyer agent to show its own principal well after the fact

export interface RefusalReceiptClaims {
  merchantId: string;
  moneyActionId?: string;
  decision: GateDecision;
  /** What was attempted — the audit event name (e.g. "money_action_attempt:order_create"), never free text the caller supplied. */
  attempted: string;
  reason: string;
  boundApplied: string | null;
  /** Whether a model influenced this decision — explainability.ts's existing Determinism value, unchanged. */
  determinism: "deterministic" | "model_influenced";
}

/**
 * Finds the audit_log row this exact gate decision just wrote. Prefers
 * moneyActionId (unambiguous) and falls back to the newest row matching
 * merchant + exact reason text — a real limitation for the rare case of
 * two identical-reason denials landing in the same instant, documented
 * here rather than hidden: this is a read of what was already recorded,
 * never a new decision, so a missed match means no receipt, not a wrong one.
 */
async function findAuditRowForResult(merchantId: string, result: GateResult) {
  if (result.moneyActionId) {
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.moneyActionId, result.moneyActionId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(1);
    if (row) return row;
  }

  const [row] = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.merchantId, merchantId))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(1);

  return row && row.reason === result.reason ? row : undefined;
}

// Model-influenced only when risk.ts's escalation reason doesn't start
// with its own deterministic-fallback prefix — the same discriminator
// explainability.ts's fetchGateAndRiskDecisions already uses.
function determinismFromAuditRow(row: { decision: string; reason: string }): "deterministic" | "model_influenced" {
  if (row.decision !== "escalate") return "deterministic";
  return row.reason.startsWith("Model unavailable. Deterministic fallback:") ? "deterministic" : "model_influenced";
}

/**
 * Signs a receipt for a just-completed gate decision. Returns undefined
 * on ANY failure — a missing audit row, a key-loading error, a signing
 * error — never throwing into a money path. A signing failure must not
 * break the refusal/allow/escalation itself: the caller still returns
 * its real result, just without a receipt attached.
 */
export async function issueRefusalReceipt(merchantId: string, result: GateResult): Promise<string | undefined> {
  try {
    const auditRow = await findAuditRowForResult(merchantId, result);
    if (!auditRow) return undefined;

    const claims: RefusalReceiptClaims = {
      merchantId,
      moneyActionId: result.moneyActionId,
      decision: result.decision,
      attempted: auditRow.event,
      reason: auditRow.reason,
      boundApplied: auditRow.boundApplied,
      determinism: determinismFromAuditRow(auditRow),
    };

    const { privateKeyPkcs8 } = await getOrCreateMandateKeypair(merchantId);
    const privateKey = await importPKCS8(privateKeyPkcs8, ALG);

    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt(now)
      .setExpirationTime(now + RECEIPT_TTL_SECONDS)
      .sign(privateKey);
  } catch (err) {
    console.warn("[refusal-receipt] Failed to issue a receipt, degrading to no receipt:", err);
    return undefined;
  }
}

/**
 * Verifies a receipt against a merchant's own public key — used by
 * tests to prove the real round trip (sign here, publish via L21-2,
 * fetch that published key over HTTP, verify) and available to any
 * real counterparty doing the same thing outside this codebase.
 */
export async function verifyRefusalReceipt(jwt: string, publicKeySpki: string): Promise<RefusalReceiptClaims> {
  const publicKey = await importSPKI(publicKeySpki, ALG);
  const { payload } = await jwtVerify(jwt, publicKey, { algorithms: [ALG] });
  return payload as unknown as RefusalReceiptClaims;
}
