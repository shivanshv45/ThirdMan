import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  robotsBlocksAgents,
  sitemapReferencesProducts,
  hasProductStructuredData,
  hasStableItemIdentifier,
  checkoutRequiresHumanOnlyStep,
  priceLooksLikeFormattedString,
  hasSkuField,
} from "./store-readiness-checks";

/**
 * L24-11: "the audit engine is shared, not forked." This is the test
 * that makes the plan's architectural claim — the Instant Audit
 * (store-checks.ts, fed HTTP-fetched pages) and the CLI (cli/src/checks/*,
 * fed filesystem reads) judge identical evidence identically — checkable
 * rather than merely asserted.
 *
 * Static half: both consuming files literally import this module, not a
 * local copy of these functions. Behavioural half: the predicates
 * themselves, called directly, agree with the fixtures both callers'
 * own test suites already exercise.
 */
describe("store-readiness-checks.ts is the one place both audits get their judgment", () => {
  it("src/lib/store-checks.ts re-exports from this file rather than defining its own copies", () => {
    const source = readFileSync(new URL("../src/lib/store-checks.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/from ["']\.\.\/\.\.\/shared\/store-readiness-checks["']/);
    // Guard against a future edit reintroducing a local duplicate.
    expect(source).not.toMatch(/function robotsBlocksAgents/);
    expect(source).not.toMatch(/function hasProductStructuredData/);
  });

  it("cli/src/checks/discoverability.ts imports the same file, not a local copy", () => {
    const source = readFileSync(new URL("../cli/src/checks/discoverability.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/from ["']\.\.\/\.\.\/\.\.\/shared\/store-readiness-checks\.js["']/);
    expect(source).not.toMatch(/function agentLikeCrawlersAreBlocked/);
  });

  it("cli/src/checks/machine-readable.ts imports the same file, not a local copy", () => {
    const source = readFileSync(new URL("../cli/src/checks/machine-readable.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/from ["']\.\.\/\.\.\/\.\.\/shared\/store-readiness-checks\.js["']/);
    expect(source).not.toMatch(/FORMATTED_PRICE_PATTERN\s*=/);
    expect(source).not.toMatch(/SKU_FIELD_PATTERN\s*=/);
  });

  it("cli/src/checks/transactability.ts imports the same file, not a local copy", () => {
    const source = readFileSync(new URL("../cli/src/checks/transactability.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/from ["']\.\.\/\.\.\/\.\.\/shared\/store-readiness-checks\.js["']/);
    expect(source).not.toMatch(/HUMAN_ONLY_PATTERNS\s*=/);
  });

  it("robotsBlocksAgents agrees on the same robots.txt content regardless of which caller (fetched vs. filesystem) supplies it", () => {
    const blocking = "User-agent: GPTBot\nDisallow: /\n";
    const permissive = "User-agent: *\nDisallow: /admin\n";
    expect(robotsBlocksAgents(blocking)).toBe(true);
    expect(robotsBlocksAgents(permissive)).toBe(false);
  });

  it("hasProductStructuredData agrees on JSON-LD content whether it came from a fetched page or a source file", () => {
    const withJsonLd = `<script type="application/ld+json">{"@type": "Product", "name": "Widget"}</script>`;
    const without = `<div class="price">₹499.00</div>`;
    expect(hasProductStructuredData(withJsonLd)).toBe(true);
    expect(hasProductStructuredData(without)).toBe(false);
  });

  it("priceLooksLikeFormattedString agrees on a formatted currency price in JSON-shaped content", () => {
    const formatted = JSON.stringify([{ sku: "ABC-1", price: "₹1,299.00" }]);
    const numeric = JSON.stringify([{ sku: "ABC-1", price: 1299 }]);
    expect(priceLooksLikeFormattedString(formatted)).toBe(true);
    expect(priceLooksLikeFormattedString(numeric)).toBe(false);
  });

  it("checkoutRequiresHumanOnlyStep agrees on a CAPTCHA reference regardless of source", () => {
    expect(checkoutRequiresHumanOnlyStep("<div class='g-recaptcha'></div>")).toBe(true);
    expect(checkoutRequiresHumanOnlyStep("<button>Pay now</button>")).toBe(false);
  });

  it("sitemapReferencesProducts and hasStableItemIdentifier/hasSkuField agree across trivial fixtures", () => {
    expect(sitemapReferencesProducts("<url><loc>/products/widget</loc></url>")).toBe(true);
    expect(sitemapReferencesProducts("<url><loc>/about</loc></url>")).toBe(false);
    expect(hasStableItemIdentifier('{"sku": "ABC-1"}')).toBe(true);
    expect(hasSkuField('{"sku": "ABC-1"}')).toBe(true);
  });
});
