import { describe, it, expect } from "vitest";
import { computeCallCostPaise, isKnownModel, listKnownModelIds } from "@/lib/model-pricing";

/**
 * Layer 14-4: real, sourced per-token pricing arithmetic. Pure and
 * deterministic — no model call, no I/O.
 */

describe("computeCallCostPaise", () => {
  it("computes a positive integer paise cost for real token counts", () => {
    const cost = computeCallCostPaise("openai/gpt-oss-20b", { promptTokens: 1000, completionTokens: 500 });
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });

  it("a more expensive model costs more for the identical token counts", () => {
    const usage = { promptTokens: 10_000, completionTokens: 5_000 };
    const cheap = computeCallCostPaise("openai/gpt-oss-20b", usage);
    const expensive = computeCallCostPaise("openai/gpt-oss-120b", usage);
    expect(expensive).toBeGreaterThan(cheap);
  });

  it("zero tokens costs zero", () => {
    expect(computeCallCostPaise("openai/gpt-oss-20b", { promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it("throws for an unknown model rather than guessing a price", () => {
    expect(() => computeCallCostPaise("not-a-real-model", { promptTokens: 100, completionTokens: 100 })).toThrow(/no pricing known/);
  });

  it("isKnownModel / listKnownModelIds reflect the same table computeCallCostPaise reads", () => {
    expect(isKnownModel("openai/gpt-oss-20b")).toBe(true);
    expect(isKnownModel("not-a-real-model")).toBe(false);
    expect(listKnownModelIds()).toContain("openai/gpt-oss-20b");
    expect(listKnownModelIds()).toContain("openai/gpt-oss-120b");
  });
});
