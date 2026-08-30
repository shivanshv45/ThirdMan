import { describe, it, expect } from "vitest";
import { runAudit } from "./audit.js";
import { makeFixture } from "./test-fixture.js";

describe("runAudit", () => {
  it("scores a bare-empty repo low, with every fix message present", () => {
    const f = makeFixture({ "README.md": "empty store" });
    try {
      const report = runAudit(f.scope);
      expect(report.score).toBeLessThan(30);
      const failed = report.checks.filter((c) => !c.passed);
      expect(failed.length).toBeGreaterThan(0);
      for (const check of failed) {
        expect(check.fix?.message).toBeTruthy();
      }
    } finally {
      f.cleanup();
    }
  });

  it("passes the discovery-document check once one exists on disk", () => {
    const f = makeFixture({
      "README.md": "x",
      ".well-known/agent-commerce.json": JSON.stringify({ schemaVersion: "1.1" }),
    });
    try {
      const report = runAudit(f.scope);
      const check = report.checks.find((c) => c.id === "has_discovery_document");
      expect(check?.passed).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("flags a formatted-currency-string price as a parsing hazard, with a real line number", () => {
    const f = makeFixture({
      "products.json": '[\n  { "sku": "ABC-1", "price": "₹1,299.00" }\n]\n',
    });
    try {
      const report = runAudit(f.scope);
      const check = report.checks.find((c) => c.id === "prices_not_formatted_strings");
      expect(check?.passed).toBe(false);
      expect(check?.fix?.file).toBe("products.json");
      // L24-2: the line VS Code's Problems panel anchors to — must point
      // at the actual offending line, not just the file.
      expect(check?.fix?.line).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  it("passes prices-not-formatted when prices are real numbers", () => {
    const f = makeFixture({
      "products.json": JSON.stringify([{ sku: "ABC-1", price: 1299 }]),
    });
    try {
      const report = runAudit(f.scope);
      expect(report.checks.find((c) => c.id === "prices_not_formatted_strings")?.passed).toBe(true);
      expect(report.checks.find((c) => c.id === "stable_sku_present")?.passed).toBe(true);
      expect(report.checks.find((c) => c.id === "catalogue_locatable")?.passed).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("flags robots.txt blocking AI-agent user agents, with a real line number", () => {
    const f = makeFixture({
      "robots.txt": "User-agent: GPTBot\nDisallow: /\n",
    });
    try {
      const report = runAudit(f.scope);
      const check = report.checks.find((c) => c.id === "robots_does_not_block_agents");
      expect(check?.passed).toBe(false);
      expect(check?.fix?.line).toBe(2); // the "Disallow: /" line itself
    } finally {
      f.cleanup();
    }
  });

  it("passes robots.txt that allows crawlers", () => {
    const f = makeFixture({
      "robots.txt": "User-agent: *\nAllow: /\n",
    });
    try {
      const report = runAudit(f.scope);
      expect(report.checks.find((c) => c.id === "robots_does_not_block_agents")?.passed).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("flags a CAPTCHA reference in a checkout file, with a real line number", () => {
    const f = makeFixture({
      "src/checkout/page.tsx": "export function Checkout() {\n  return <Recaptcha />;\n}\n",
    });
    try {
      const report = runAudit(f.scope);
      const check = report.checks.find((c) => c.id === "no_human_only_checkout_gate");
      expect(check?.passed).toBe(false);
      expect(check?.fix?.file).toBe("src/checkout/page.tsx");
      expect(check?.fix?.line).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  it("passes schema.org/Product structured data when present on a product page", () => {
    const f = makeFixture({
      "src/pages/product/[id].tsx": `const jsonLd = { "@type": "Product", "schema.org/Product": true };`,
    });
    try {
      const report = runAudit(f.scope);
      expect(report.checks.find((c) => c.id === "product_structured_data")?.passed).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("never reads outside the project root even if a check touches an absolute-looking path", () => {
    const f = makeFixture({ "README.md": "x" });
    try {
      expect(() => f.scope.resolve("../../etc/passwd")).toThrow();
      expect(() => f.scope.readFile("../outside.txt")).toThrow();
    } finally {
      f.cleanup();
    }
  });
});
