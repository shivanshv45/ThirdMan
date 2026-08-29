import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeAllocationSplit, validateShareConfig, TOTAL_BASIS_POINTS } from "@/lib/treasury";

/**
 * Layer 14-1/14-6: property-based proof that the allocation split never
 * loses or invents a paise. For ANY legal capture amount and ANY legal
 * share configuration, buyerPaise + merchantPaise + reservePaise must
 * sum to exactly contributionPaise, and contributionPaise itself must
 * never exceed floor(capturedPaise * allocationBasisPoints / 10000).
 */

const legalShares = fc
  .tuple(fc.integer({ min: 0, max: TOTAL_BASIS_POINTS }), fc.integer({ min: 0, max: TOTAL_BASIS_POINTS }))
  .map(([a, b]) => {
    const buyerShareBps = Math.min(a, b);
    const merchantShareBps = Math.max(a, b) - buyerShareBps;
    const reserveShareBps = TOTAL_BASIS_POINTS - buyerShareBps - merchantShareBps;
    return { buyerShareBps, merchantShareBps, reserveShareBps };
  });

describe("computeAllocationSplit — property-based proof", () => {
  it("the three shares always sum to exactly the contribution, for any legal configuration", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000_00 }), // up to ₹1 crore captured
        fc.integer({ min: 0, max: TOTAL_BASIS_POINTS }),
        legalShares,
        (capturedPaise, allocationBasisPoints, shares) => {
          const split = computeAllocationSplit(capturedPaise, { allocationBasisPoints, ...shares });
          expect(split.buyerPaise + split.merchantPaise + split.reservePaise).toBe(split.contributionPaise);
          expect(split.contributionPaise).toBe(Math.floor((capturedPaise * allocationBasisPoints) / TOTAL_BASIS_POINTS));
          expect(split.buyerPaise).toBeGreaterThanOrEqual(0);
          expect(split.merchantPaise).toBeGreaterThanOrEqual(0);
          expect(split.reservePaise).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("never allocates more than the captured amount itself", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000_00 }), fc.integer({ min: 0, max: TOTAL_BASIS_POINTS }), legalShares, (capturedPaise, allocationBasisPoints, shares) => {
        const split = computeAllocationSplit(capturedPaise, { allocationBasisPoints, ...shares });
        expect(split.contributionPaise).toBeLessThanOrEqual(capturedPaise);
      }),
      { numRuns: 500 },
    );
  });

  it("a non-positive or non-integer captured amount allocates nothing", () => {
    for (const bad of [0, -100, 5.5]) {
      const split = computeAllocationSplit(bad, { allocationBasisPoints: 500, buyerShareBps: 4000, merchantShareBps: 4000, reserveShareBps: 2000 });
      expect(split).toEqual({ contributionPaise: 0, buyerPaise: 0, merchantPaise: 0, reservePaise: 0 });
    }
  });

  it("zero allocationBasisPoints funds nothing", () => {
    const split = computeAllocationSplit(1_000_00, { allocationBasisPoints: 0, buyerShareBps: 4000, merchantShareBps: 4000, reserveShareBps: 2000 });
    expect(split.contributionPaise).toBe(0);
  });
});

describe("validateShareConfig", () => {
  it("accepts shares that sum to exactly 10000", () => {
    expect(validateShareConfig(4000, 4000, 2000)).toBeNull();
    expect(validateShareConfig(0, 0, 10_000)).toBeNull();
    expect(validateShareConfig(10_000, 0, 0)).toBeNull();
  });

  it("rejects shares that don't sum to 10000", () => {
    expect(validateShareConfig(4000, 4000, 1000)).toMatch(/must sum to exactly/);
    expect(validateShareConfig(5000, 5000, 5000)).toMatch(/must sum to exactly/);
  });

  it("rejects negative or non-integer shares", () => {
    expect(validateShareConfig(-100, 5000, 5100)).toMatch(/non-negative integer/);
    expect(validateShareConfig(4000.5, 4000, 2000)).toMatch(/non-negative integer/);
  });
});
