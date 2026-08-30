import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 24-8: Shadow Mode. "Install it and it changes nothing" — every
 * agent still runs, the gate still evaluates every bound, but no real
 * money action can execute while a merchant's row exists here. A
 * presence table, the same discipline merchantFreezes (Layer 25-2)
 * already established: a row means shadow mode is on, absence means
 * off. See gate.ts's attemptMoneyActionTraced, the ONLY place this is
 * checked — enforced in the gate, never by a UI hiding a button, per
 * the plan's explicit "must get right" requirement.
 */

export async function isShadowModeEnabled(merchantId: string): Promise<boolean> {
  const [row] = await db.select({ merchantId: schema.merchantShadowMode.merchantId }).from(schema.merchantShadowMode).where(eq(schema.merchantShadowMode.merchantId, merchantId));
  return row !== undefined;
}

export async function getShadowModeState(merchantId: string): Promise<{ enabledAt: Date } | null> {
  const [row] = await db.select().from(schema.merchantShadowMode).where(eq(schema.merchantShadowMode.merchantId, merchantId));
  return row ? { enabledAt: row.enabledAt } : null;
}

export async function enableShadowMode(merchantId: string): Promise<void> {
  const existing = await getShadowModeState(merchantId);
  if (existing) return; // already on — not an error, just a no-op

  await db.insert(schema.merchantShadowMode).values({ merchantId });
  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "shadow_mode_enabled",
    decision: "n/a",
    reason: "Merchant enabled Shadow Mode — every money action will be evaluated as a real request but will not execute until Shadow Mode is turned off.",
  });
}

export async function disableShadowMode(merchantId: string): Promise<void> {
  const existing = await getShadowModeState(merchantId);
  if (!existing) return;

  await db.delete(schema.merchantShadowMode).where(eq(schema.merchantShadowMode.merchantId, merchantId));
  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "shadow_mode_disabled",
    decision: "n/a",
    reason: "Merchant turned off Shadow Mode — money actions will execute normally again.",
  });
}
