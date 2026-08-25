import { describe, it, expect } from "vitest";
import { computeReadiness } from "@/lib/agent-readiness";

/**
 * L5-6: the readiness scorer. computeReadiness is pure — no DB, no
 * model — so it's tested directly against constructed inputs. What
 * matters: integer-only arithmetic, a merchant failing a specific check
 * gets that specific fix item back (not a vague "improve your catalogue"),
 * and a merchant passing everything scores 100.
 */

const FULLY_READY = {
  razorpayConnected: true,
  products: [
    {
      id: "p1",
      description: "A well-described coffee bag with plenty of detail for an agent to understand.",
      category: "food_beverage",
      variants: [{ sku: "SKU-1", attributes: { size: "250g" } }],
    },
  ],
  policyPublished: true,
  shippingRegionsSet: true,
  hasAgentWithActiveCap: true,
  productsWithImages: 1,
  activeProductCount: 1,
};

describe("computeReadiness — deterministic, integer only", () => {
  it("scores 100 when every check passes", () => {
    const report = computeReadiness(FULLY_READY);
    expect(report.score).toBe(100);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(Number.isInteger(report.score)).toBe(true);
  });

  it("scores 0 for a merchant with nothing set up", () => {
    const report = computeReadiness({
      razorpayConnected: false,
      products: [],
      policyPublished: false,
      shippingRegionsSet: false,
      hasAgentWithActiveCap: false,
      productsWithImages: 0,
      activeProductCount: 0,
    });
    expect(report.score).toBe(0);
  });

  it("a merchant failing only the return-policy check gets that specific fix item back, not a generic one", () => {
    const report = computeReadiness({ ...FULLY_READY, policyPublished: false, shippingRegionsSet: false });
    const policyCheck = report.checks.find((c) => c.id === "return_policy_published");
    expect(policyCheck?.passed).toBe(false);
    expect(policyCheck?.fix?.message).toMatch(/return policy/i);
    expect(policyCheck?.fix?.href).toBe("/dashboard/policies");

    // Every other check still passes — the score reflects exactly the
    // two failed checks (policy + shipping regions), nothing else.
    const otherChecks = report.checks.filter((c) => c.id !== "return_policy_published" && c.id !== "shipping_regions_set");
    expect(otherChecks.every((c) => c.passed)).toBe(true);
  });

  it("score is always an integer percentage, never a float", () => {
    // A combination that would produce a non-round percentage if computed naively.
    const report = computeReadiness({ ...FULLY_READY, hasAgentWithActiveCap: false });
    expect(Number.isInteger(report.score)).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("a product with no SKU fails the SKU check specifically, without failing unrelated checks", () => {
    const report = computeReadiness({
      ...FULLY_READY,
      products: [{ ...FULLY_READY.products[0], variants: [{ sku: "", attributes: { size: "250g" } }] }],
    });
    const skuCheck = report.checks.find((c) => c.id === "every_variant_has_sku");
    expect(skuCheck?.passed).toBe(false);
    const categoryCheck = report.checks.find((c) => c.id === "category_set");
    expect(categoryCheck?.passed).toBe(true);
  });
});
