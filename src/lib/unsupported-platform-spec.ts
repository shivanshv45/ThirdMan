/**
 * Layer 24-6: for a platform none of L24-2/3/4/5 covers (a hand-rolled
 * PHP site, a niche cart platform, an internal admin panel), a precise
 * written specification of what needs to exist — framed for a human
 * developer to implement and review, never as an instruction to paste
 * into an AI that edits a live store. That distinction is the whole
 * point of this task (see plan L24-6 and the layer's governing rule):
 * a spec whose result the merchant's developer reviews before deploying
 * is safe; an instruction whose result nobody checks is the exact
 * failure mode the governing rule exists to prevent.
 *
 * Deterministic string generation — no model, no fetch, no write to
 * anything. This module produces text; it never touches the merchant's
 * site.
 */

export interface UnsupportedPlatformSpecContext {
  merchantId: string;
  merchantName: string;
  appOrigin: string;
  publishableKey: string;
}

export function generateUnsupportedPlatformSpec(ctx: UnsupportedPlatformSpecContext): string {
  return `# Agent-commerce integration spec for ${ctx.merchantName}

**This is a specification for a human developer to implement and review — not an instruction for an AI assistant to carry out unsupervised on your live store.** Paste this into a ticket, a PR description, or hand it to whoever maintains your site. Whatever they build from it should be reviewed and deployed the same way any other change to your storefront is, and verified afterward with the check below.

## Why this exists

Thirdman audited your store's platform and did not recognise it as one of the platforms it integrates with directly (Next.js/static HTML via the CLI, Shopify, or WooCommerce). Everything below is unverified by us until you run the verification step at the end — this document describes what needs to exist, not a guarantee that it does yet.

## 1. Discovery document

Serve the following JSON, verbatim, at exactly this path on your domain:

\`\`\`
GET /.well-known/agent-commerce.json
\`\`\`

The simplest correct implementation is a server-side redirect (301 or a reverse proxy, not a client-side redirect) from that path to:

\`\`\`
${ctx.appOrigin}/store/${ctx.merchantId}/manifest.json
\`\`\`

This keeps the document live — it always reflects your real, current catalogue and policy, never a copy that can go stale. If your platform cannot redirect at that exact path, proxy the request server-side and return the upstream response body and \`Content-Type: application/json\` unchanged.

## 2. Structured data on every product page

Each page where a single product can be bought needs one \`<script type="application/ld+json">\` block in the page's HTML, built from that product's real, current data at render time:

\`\`\`json
{
  "@context": "https://schema.org/",
  "@type": "Product",
  "name": "<the real product name>",
  "sku": "<the real, stable SKU>",
  "offers": {
    "@type": "Offer",
    "priceCurrency": "INR",
    "price": "<the real numeric price, e.g. 999.00 — never a formatted string like \\"₹999.00\\">",
    "availability": "https://schema.org/InStock or https://schema.org/OutOfStock, from real inventory"
  }
}
\`\`\`

Every value must come from the same source of truth your storefront already renders prices and stock from — never a hardcoded or example value left in place.

## 3. The buyer widget

Add this script tag, unmodified, to every page you want the chat widget to appear on — typically a shared layout or footer template, once, not per-page:

\`\`\`html
<script async src="${ctx.appOrigin}/api/embed/v1.js" data-embed-key="${ctx.publishableKey}"></script>
\`\`\`

The value in \`data-embed-key\` is a publishable key — safe to appear in public HTML, not a secret. If this key is ever rotated from your dashboard, this script tag needs to be updated with the new value.

## 4. robots.txt

Confirm your \`robots.txt\` does not disallow AI-agent crawlers. If it currently has a blanket \`Disallow: /\` for \`User-agent: *\`, add explicit allow rules above it for at least:

\`\`\`
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /
\`\`\`

## What this document does not cover

It does not include catalogue import, order/payment integration, or anything requiring write access to your store — those are out of scope for a spec a developer implements from a document. If your platform's own AI assistant can read this document, having a human review its proposed changes before they go live to your store is still required — this document is a spec to review, not an instruction to execute unsupervised.

## 5. Verify it worked

Once implemented and deployed, verify with \`npx thirdman doctor\` (see /dashboard/cli) or the integration check on your Thirdman dashboard (/dashboard/embed) — both run real, live checks against your actual domain rather than trusting this document's instructions were followed correctly.
`;
}
