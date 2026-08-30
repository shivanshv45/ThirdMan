import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Layer 24-9: "Did it actually work?" — real checks against a merchant's
 * own real, live state, run on demand from the dashboard. This is
 * `thirdman doctor` (Layer 20) surfaced where a merchant already is,
 * reusing the same shape (AuditCheck-equivalent), but the doctor.ts in
 * cli/ checks a LOCAL filesystem plus an optional caller-supplied agent
 * key; this checks the merchant's real DB state plus real HTTP calls to
 * this app's own public endpoints — deliberately not shared code with
 * cli/, which has its own standalone-package boundary (no src/lib
 * import — see cli/package.json and PROGRESS.md's L20 entry), same as
 * store-checks.ts's relationship to cli/'s checks.
 *
 * Every check here is either a real DB read or a real fetch this
 * process makes to its own already-public routes — nothing here is
 * simulated or guessed.
 */

export interface IntegrationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface IntegrationVerifyReport {
  checks: IntegrationCheck[];
  checkedAt: string;
}

export async function verifyIntegration(merchantId: string, appOrigin: string): Promise<IntegrationVerifyReport> {
  const checks: IntegrationCheck[] = [];

  checks.push(await checkOriginAllowlisted(merchantId));
  checks.push(await checkDiscoveryDocumentResolves(merchantId, appOrigin));
  checks.push(await checkMcpEndpointLive(appOrigin));
  checks.push(await checkAgentAuthenticated(merchantId));
  checks.push(await checkFirstPurchaseGated(merchantId));

  return { checks, checkedAt: new Date().toISOString() };
}

async function checkOriginAllowlisted(merchantId: string): Promise<IntegrationCheck> {
  const [embed] = await db.select({ allowedOrigins: schema.embedConfigs.allowedOrigins }).from(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchantId));
  const count = embed?.allowedOrigins.length ?? 0;
  return {
    id: "origin_allowlisted",
    label: "At least one storefront origin is allowlisted for the embed",
    passed: count > 0,
    detail: count > 0 ? `${count} origin${count === 1 ? "" : "s"} allowlisted.` : "No origin is allowlisted yet — the embed will refuse to load anywhere until you add one on the Embed page.",
  };
}

async function checkDiscoveryDocumentResolves(merchantId: string, appOrigin: string): Promise<IntegrationCheck> {
  const url = `${appOrigin}/store/${merchantId}/manifest.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    return {
      id: "discovery_document_resolves",
      label: "The live discovery document resolves over HTTP",
      passed: res.ok,
      detail: res.ok ? `${url} returned HTTP 200.` : `${url} returned HTTP ${res.status}.`,
    };
  } catch (err) {
    return {
      id: "discovery_document_resolves",
      label: "The live discovery document resolves over HTTP",
      passed: false,
      detail: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkMcpEndpointLive(appOrigin: string): Promise<IntegrationCheck> {
  const url = `${appOrigin}/api/mcp`;
  try {
    // No credential attached deliberately — this proves the endpoint is
    // live and enforcing auth (401), not that any one agent's key still
    // works. A stored raw agent key is never available to check with
    // (agents.apiKeyHash is a hash, by design — see agent-auth.ts), so
    // "the endpoint correctly rejects an unauthenticated call" is the
    // honest ceiling of what this check can prove without asking the
    // merchant to paste a key in.
    const res = await fetch(url, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) });
    return {
      id: "mcp_endpoint_live",
      label: "The MCP endpoint is live and enforcing agent authentication",
      passed: res.status === 401,
      detail: res.status === 401 ? "The MCP endpoint correctly rejected an unauthenticated request." : `Expected HTTP 401 for an unauthenticated request, got ${res.status}.`,
    };
  } catch (err) {
    return {
      id: "mcp_endpoint_live",
      label: "The MCP endpoint is live and enforcing agent authentication",
      passed: false,
      detail: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkAgentAuthenticated(merchantId: string): Promise<IntegrationCheck> {
  const agents = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .innerJoin(schema.agentCapabilities, eq(schema.agentCapabilities.agentId, schema.agents.id))
    .where(and(eq(schema.agents.merchantId, merchantId), eq(schema.agents.status, "active")));
  const distinctAgentCount = new Set(agents.map((a) => a.id)).size;
  return {
    id: "agent_capable_of_authenticating",
    label: "At least one active agent has real capability grants",
    passed: distinctAgentCount > 0,
    detail: distinctAgentCount > 0 ? `${distinctAgentCount} active agent${distinctAgentCount === 1 ? "" : "s"} with at least one capability granted.` : "No active agent has any capability granted yet — an agent key exists without one denies every call, by deny-by-default design.",
  };
}

async function checkFirstPurchaseGated(merchantId: string): Promise<IntegrationCheck> {
  const [row] = await db.select({ id: schema.moneyActions.id }).from(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId)).limit(1);
  return {
    id: "first_purchase_gated",
    label: "At least one real money action has been evaluated by the gate",
    passed: !!row,
    detail: row ? "A real money action exists — the gate has evaluated at least one real request end to end." : "No money action has been attempted yet — this check will pass once an agent makes its first real request.",
  };
}
