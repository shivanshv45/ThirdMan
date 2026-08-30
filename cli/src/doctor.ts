import { ProjectScope } from "./fs-scope.js";
import { checkIntegrationState } from "./checks/integration.js";
import type { AuditCheck } from "./types.js";

/**
 * L20-1's `thirdman doctor`: verify a previously-completed integration
 * still works — local checks (already covered by
 * checks/integration.ts) plus the network-dependent ones the plan
 * names: does the discovery document resolve for real, does the agent
 * key still authenticate. Both network checks degrade to a failed
 * check with a clear reason on any network error — never a crash.
 */

export interface DoctorConfig {
  appOrigin: string;
  merchantId?: string;
  apiKey?: string;
}

export async function runDoctor(scope: ProjectScope, config: DoctorConfig): Promise<AuditCheck[]> {
  const allFiles = scope.listFiles(".");
  const checks = checkIntegrationState(scope, allFiles);

  checks.push(await checkDiscoveryResolves(config));
  if (config.apiKey) {
    checks.push(await checkAgentKeyAuthenticates(config));
  }

  return checks;
}

async function checkDiscoveryResolves(config: DoctorConfig): Promise<AuditCheck> {
  const url = config.merchantId ? `${config.appOrigin}/store/${config.merchantId}/manifest.json` : `${config.appOrigin}/.well-known/agent-commerce.json`;
  try {
    const res = await fetch(url);
    return {
      id: "discovery_document_resolves",
      label: "The live discovery document resolves over HTTP",
      weight: 20,
      passed: res.ok,
      fix: res.ok ? undefined : { message: `${url} returned HTTP ${res.status}.` },
    };
  } catch (err) {
    return {
      id: "discovery_document_resolves",
      label: "The live discovery document resolves over HTTP",
      weight: 20,
      passed: false,
      fix: { message: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

async function checkAgentKeyAuthenticates(config: DoctorConfig): Promise<AuditCheck> {
  const url = `${config.appOrigin}/api/agent/products`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.apiKey}` } });
    return {
      id: "agent_key_authenticates",
      label: "The linked agent key still authenticates",
      weight: 20,
      passed: res.status !== 401,
      fix: res.status === 401 ? { message: "The agent key was rejected (HTTP 401) — it may have been rotated or revoked. Re-link with `thirdman init`." } : undefined,
    };
  } catch (err) {
    return {
      id: "agent_key_authenticates",
      label: "The linked agent key still authenticates",
      weight: 20,
      passed: false,
      fix: { message: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}
