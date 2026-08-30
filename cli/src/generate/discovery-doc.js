import { generatedByField } from "./headers.js";
/**
 * L20-5: a static /.well-known/agent-commerce.json for a site with no
 * server routes of its own. This is deliberately a minimal, honest
 * subset of discovery-manifest.ts's real shape (Layer 21) — the CLI has
 * no database access, so it cannot report a real catalogue count or
 * policy summary. Every field here is either a fact this tool can prove
 * from the filesystem/CLI args, or an explicit pointer to the real,
 * live manifest this merchant's account already serves. If Layer 21's
 * shape changes, this writes whatever the currently-deployed version
 * defines and is upgraded alongside it — see plans/layer-20-merchant-cli.md L20-5.
 */
export function generateDiscoveryDoc(opts) {
    const doc = {
        schemaVersion: "1.1",
        ...generatedByField(),
        merchant: {
            id: opts.merchantId,
            name: opts.merchantName,
            storefrontUrl: opts.origin,
        },
        note: opts.merchantId
            ? `The authoritative, live version of this document is served by your Thirdman account at ${opts.appOrigin}/store/${opts.merchantId}/manifest.json — this static copy exists for sites that serve no server routes of their own and should be regenerated (not hand-edited) if your account details change.`
            : `This merchant has not linked a Thirdman account yet. Run \`thirdman init\` again after linking (see ${opts.appOrigin}/dashboard/cli) to fill in real catalogue and agent-access details.`,
        agentAccess: opts.merchantId
            ? {
                mcp: { endpoint: `${opts.appOrigin}/api/mcp`, transport: "streamable-http", authentication: "bearer" },
                restApiBase: `${opts.appOrigin}/api/agent`,
            }
            : null,
    };
    return {
        relativePath: ".well-known/agent-commerce.json",
        newContent: `${JSON.stringify(doc, null, 2)}\n`,
    };
}
//# sourceMappingURL=discovery-doc.js.map