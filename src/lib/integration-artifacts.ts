import { buildSnippet } from "../../shared/embed-snippet";

/**
 * Layer 24-5: the universal fallback for any platform without a
 * dedicated integration (L24-3/L24-4). Given a failed check from the
 * Instant Audit (store-audit.ts) or the merchant's own embed config,
 * returns the exact block to paste and the exact place to paste it —
 * never a description of what to do. Reuses shared/embed-snippet.ts's
 * buildSnippet directly, so the widget artifact here is byte-identical
 * to what `npx thirdman init` would write.
 *
 * Deterministic, pure string generation — no model, no fetch, no write.
 * The merchant pastes it themselves; nothing here touches their site.
 */

export interface IntegrationArtifact {
  checkId: string;
  title: string;
  /** Where the merchant pastes this — a file path for a codebase, or an admin screen name for a hosted platform. */
  placement: string;
  content: string;
  /** A short note on why this fixes the finding, shown above the block. */
  note: string;
}

export interface ArtifactContext {
  appOrigin: string;
  publishableKey: string;
  platformHint?: "shopify_no_app" | "generic";
}

const ROBOTS_FIX_LINES = [
  "User-agent: GPTBot",
  "Allow: /",
  "",
  "User-agent: ClaudeBot",
  "Allow: /",
  "",
  "User-agent: Google-Extended",
  "Allow: /",
].join("\n");

/**
 * Returns an artifact for a given failed check id, or null if this check
 * has no known paste-able fix (e.g. "product pages carry structured
 * data" needs real per-product work no generic snippet can supply).
 * Returning null rather than a guessed fix is the same honesty rule
 * store-checks.ts's notEvaluated already follows for fetch failures.
 */
export function artifactForCheck(checkId: string, ctx: ArtifactContext): IntegrationArtifact | null {
  switch (checkId) {
    case "has_discovery_document":
      return {
        checkId,
        title: "Add the agent discovery document",
        placement:
          ctx.platformHint === "shopify_no_app"
            ? "Shopify Admin → Online Store → Themes → Edit code → add a new template file"
            : "Your site root, served at exactly /.well-known/agent-commerce.json",
        content: `${ctx.appOrigin}/store/<your-merchant-id>/manifest.json`,
        note: "An AI buyer looks for this document first. The fastest correct fix is redirecting /.well-known/agent-commerce.json on your own domain to the real, live manifest your account already serves at the URL above — never a static copy that can go stale.",
      };

    case "robots_does_not_block_agents":
      return {
        checkId,
        title: "Un-block AI-agent crawlers in robots.txt",
        placement: "robots.txt, at your site root",
        content: ROBOTS_FIX_LINES,
        note: "Add these lines above any existing wildcard Disallow rule. A merchant asking to be sold to by agents while blocking them at the door is a real, common, invisible mistake.",
      };

    case "sitemap_lists_products":
    case "sitemap_present":
      return {
        checkId,
        title: "Reference product pages in your sitemap",
        placement: "sitemap.xml, at your site root",
        content: `<url>\n  <loc>https://your-store.example.com/products/example-product</loc>\n</url>`,
        note: "Add one <url> entry per product page (most platforms generate this automatically once product URLs follow a consistent pattern — the fix here is making sure product pages are included, not hand-writing every entry).",
      };

    case "product_structured_data":
      return {
        checkId,
        title: "Add schema.org/Product structured data to a product page",
        placement: "Inside the product page's <head>, or right after the opening <body> tag",
        content: `<script type="application/ld+json">\n{\n  "@context": "https://schema.org/",\n  "@type": "Product",\n  "name": "Example product name",\n  "sku": "YOUR-SKU",\n  "offers": {\n    "@type": "Offer",\n    "priceCurrency": "INR",\n    "price": "999.00",\n    "availability": "https://schema.org/InStock"\n  }\n}\n</script>`,
        note: "Replace the placeholder name/SKU/price with this product's real values — this is a template, not a value to paste unchanged. Every purchasable variant needs its own block.",
      };

    case "no_human_only_checkout_gate":
      return null; // real product work, no generic snippet fixes a CAPTCHA gate

    case "integration_embed_present":
    case "has_widget":
      return {
        checkId,
        title: "Add the buyer widget",
        placement: "Just before the closing </body> tag on every page you want the widget to appear",
        content: buildSnippet(ctx.appOrigin, ctx.publishableKey),
        note: "This is the exact same snippet `npx thirdman init` would inject automatically for a supported stack — safe to paste once, and safe to leave in place if you later install the CLI or the Shopify app (they detect and update it in place rather than duplicating it).",
      };

    default:
      return null;
  }
}

export function artifactsForReport(checkIds: string[], ctx: ArtifactContext): IntegrationArtifact[] {
  return checkIds.map((id) => artifactForCheck(id, ctx)).filter((a): a is IntegrationArtifact => a !== null);
}
