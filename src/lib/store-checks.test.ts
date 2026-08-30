import { describe, it, expect } from "vitest";
import { robotsBlocksAgents, sitemapReferencesProducts, hasProductStructuredData, hasStableItemIdentifier, checkoutRequiresHumanOnlyStep, priceLooksLikeFormattedString, computeStoreScore, type StoreCheck } from "./store-checks";

describe("robotsBlocksAgents", () => {
  it("is false for a robots.txt with no blocking rules", () => {
    expect(robotsBlocksAgents("User-agent: *\nDisallow: /admin\n")).toBe(false);
  });

  it("is true when a wildcard user-agent disallows the whole site", () => {
    expect(robotsBlocksAgents("User-agent: *\nDisallow: /\n")).toBe(true);
  });

  it("is true when GPTBot specifically is blocked at root", () => {
    expect(robotsBlocksAgents("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n")).toBe(true);
  });

  it("is false when only a specific path (not root) is disallowed for an agent-like UA", () => {
    expect(robotsBlocksAgents("User-agent: ClaudeBot\nDisallow: /private\n")).toBe(false);
  });
});

describe("sitemapReferencesProducts", () => {
  it("is true when the sitemap content mentions product urls", () => {
    expect(sitemapReferencesProducts("<urlset><url><loc>https://x.com/products/shoe</loc></url></urlset>")).toBe(true);
  });
  it("is false when nothing product-shaped appears", () => {
    expect(sitemapReferencesProducts("<urlset><url><loc>https://x.com/about</loc></url></urlset>")).toBe(false);
  });
});

describe("hasProductStructuredData", () => {
  it("detects JSON-LD schema.org/Product", () => {
    expect(hasProductStructuredData('<script type="application/ld+json">{"@type": "Product", "name": "Shoe"}</script>')).toBe(true);
  });
  it("detects microdata itemtype", () => {
    expect(hasProductStructuredData('<div itemscope itemtype="https://schema.org/Product">')).toBe(true);
  });
  it("is false for plain rendered text with no structured markup", () => {
    expect(hasProductStructuredData("<h1>Running Shoe</h1><p>₹1,299.00</p>")).toBe(false);
  });
});

describe("hasStableItemIdentifier", () => {
  it("detects a sku field", () => {
    expect(hasStableItemIdentifier('{"sku": "SHOE-42-BLK"}')).toBe(true);
  });
  it("detects a JSON-LD productID field", () => {
    expect(hasStableItemIdentifier('{"productID": "abc123"}')).toBe(true);
  });
  it("is false with no identifier field present", () => {
    expect(hasStableItemIdentifier("<h1>Running Shoe</h1>")).toBe(false);
  });
});

describe("checkoutRequiresHumanOnlyStep", () => {
  it("detects a captcha reference", () => {
    expect(checkoutRequiresHumanOnlyStep('<div class="g-recaptcha"></div>')).toBe(true);
  });
  it("detects an OTP reference", () => {
    expect(checkoutRequiresHumanOnlyStep("Enter the OTP sent to your phone")).toBe(true);
  });
  it("is false for a checkout page with neither", () => {
    expect(checkoutRequiresHumanOnlyStep("<button>Pay now</button>")).toBe(false);
  });
});

describe("priceLooksLikeFormattedString", () => {
  it("detects a rupee-formatted price string", () => {
    expect(priceLooksLikeFormattedString('<span>₹1,299.00</span>')).toBe(true);
  });
  it("is false for a plain numeric value", () => {
    expect(priceLooksLikeFormattedString('{"price": 129900}')).toBe(false);
  });
});

describe("computeStoreScore", () => {
  it("weights only evaluated checks", () => {
    const checks: StoreCheck[] = [
      { id: "a", label: "a", weight: 50, passed: true },
      { id: "b", label: "b", weight: 50, passed: false },
    ];
    expect(computeStoreScore(checks)).toBe(50);
  });

  it("excludes notEvaluated checks from both numerator and denominator", () => {
    const checks: StoreCheck[] = [
      { id: "a", label: "a", weight: 50, passed: true },
      { id: "b", label: "b", weight: 50, passed: false, notEvaluated: { reason: "blocked" } },
    ];
    // b is excluded entirely — score is 100% of the checks that actually ran, not 50%.
    expect(computeStoreScore(checks)).toBe(100);
  });

  it("is 0 when every check is notEvaluated (never fabricates a low score for a site we couldn't inspect)", () => {
    const checks: StoreCheck[] = [{ id: "a", label: "a", weight: 50, passed: false, notEvaluated: { reason: "blocked" } }];
    expect(computeStoreScore(checks)).toBe(0);
  });
});
