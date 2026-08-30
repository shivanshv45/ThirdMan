/**
 * Layer 24-11: the one file both the Instant Audit (`src/lib/store-checks.ts`,
 * fed real fetched HTTP pages) and the merchant CLI (`cli/src/checks/*.ts`,
 * fed real files on disk) import for the *judgment* half of "is this store
 * agent-ready" — is a given string of HTML/robots.txt/sitemap content
 * evidence of a pass or a fail. Neither caller reads or fetches anything
 * itself; each hands this module the text it already has.
 *
 * This is deliberately outside both `src/` and `cli/src/` so that no
 * package-boundary work (path aliases, a build step, a workspace
 * dependency) is required for either side to import it — both are plain
 * relative imports of the same file on disk, which is what makes "the
 * two audits cannot silently diverge in their judgment" a property a
 * test can check by import identity, not just by re-running both audits
 * and comparing outputs.
 *
 * *Evidence-gathering* still differs by design (HTTP fetch vs. filesystem
 * read, discussed in DECISIONS.md's L20-3 entry on why AuditCheck/
 * ReadinessCheck stayed separate shapes) — only the predicates below are
 * shared. Every function here is pure: no network, no filesystem, no
 * model. CLAUDE.md rule 2 applied to "is this store ready," not just to
 * a money decision.
 */
const AGENT_LIKE_USER_AGENTS = ["gptbot", "claudebot", "google-extended", "ccbot", "anthropic-ai", "*"];
/** True if robots.txt disallows the whole site to a user agent that looks like an AI crawler. */
export function robotsBlocksAgents(robotsContent) {
    const lines = robotsContent.split("\n").map((l) => l.trim().toLowerCase());
    let currentAgentBlocked = false;
    let blocksRoot = false;
    for (const line of lines) {
        if (line.startsWith("user-agent:")) {
            const agent = line.slice("user-agent:".length).trim();
            currentAgentBlocked = AGENT_LIKE_USER_AGENTS.some((a) => agent === a || agent.includes(a));
        }
        else if (line.startsWith("disallow:") && currentAgentBlocked) {
            const value = line.slice("disallow:".length).trim();
            if (value === "/")
                blocksRoot = true;
        }
    }
    return blocksRoot;
}
/** True if a sitemap's own content appears to reference product pages, not just other page kinds. */
export function sitemapReferencesProducts(sitemapContent) {
    return /product/i.test(sitemapContent);
}
/** True if a page's markup carries schema.org/Product structured data (JSON-LD or microdata). */
export function hasProductStructuredData(pageContent) {
    return (pageContent.includes("schema.org/Product") ||
        pageContent.includes('"@type":"Product"') ||
        pageContent.includes('"@type": "Product"') ||
        /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(pageContent));
}
/** True if a page references a stable identifier field per item — SKU, GTIN, MPN, or an @id/productID JSON-LD field. */
export function hasStableItemIdentifier(pageContent) {
    return /\bsku\b/i.test(pageContent) || /\bgtin\d*\b/i.test(pageContent) || /"productID"\s*:/i.test(pageContent) || /"@id"\s*:/i.test(pageContent);
}
const HUMAN_ONLY_PATTERNS = [/captcha/i, /recaptcha/i, /hcaptcha/i, /\botp\b/i, /one-time.?password/i];
/** True if checkout-path content references a CAPTCHA/OTP step that would block a headless agent buyer. */
export function checkoutRequiresHumanOnlyStep(checkoutContent) {
    return HUMAN_ONLY_PATTERNS.some((p) => p.test(checkoutContent));
}
/** True if a price appears only as a pre-formatted currency string rather than a parseable structured value. */
export function priceLooksLikeFormattedString(content) {
    return /["'`>](\$|₹|£|€)\s?[\d,]+\.\d{2}["'`<]/.test(content);
}
const SKU_FIELD_PATTERN = /\bsku\b/i;
/** True if content carries a field that looks like a SKU — a looser check than hasStableItemIdentifier, used against raw catalogue source rather than rendered HTML. */
export function hasSkuField(content) {
    return SKU_FIELD_PATTERN.test(content);
}
//# sourceMappingURL=store-readiness-checks.js.map