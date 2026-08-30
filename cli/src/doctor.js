import { checkIntegrationState } from "./checks/integration.js";
export async function runDoctor(scope, config) {
    const allFiles = scope.listFiles(".");
    const checks = checkIntegrationState(scope, allFiles);
    checks.push(await checkDiscoveryResolves(config));
    if (config.apiKey) {
        checks.push(await checkAgentKeyAuthenticates(config));
    }
    return checks;
}
async function checkDiscoveryResolves(config) {
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
    }
    catch (err) {
        return {
            id: "discovery_document_resolves",
            label: "The live discovery document resolves over HTTP",
            weight: 20,
            passed: false,
            fix: { message: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` },
        };
    }
}
async function checkAgentKeyAuthenticates(config) {
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
    }
    catch (err) {
        return {
            id: "agent_key_authenticates",
            label: "The linked agent key still authenticates",
            weight: 20,
            passed: false,
            fix: { message: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` },
        };
    }
}
//# sourceMappingURL=doctor.js.map