import { describe, it, expect } from "vitest";
import { computeCallCostPaise, isKnownModel, listKnownModelIds, providerForModel } from "@/lib/model-pricing";

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

  // Layer 16: every provider llm.ts can route to has a real, priced
  // model in this table — a routable provider with no pricing row would
  // let a call happen that computeCallCostPaise can never cost.
  it("every Layer 16 provider has at least one known, priced model", () => {
    expect(listKnownModelIds()).toContain("nvidia/nemotron-3-nano-30b-a3b");
    expect(listKnownModelIds()).toContain("z-ai/glm-4.6");
    expect(listKnownModelIds()).toContain("glm-4.6");
    for (const modelId of ["nvidia/nemotron-3-nano-30b-a3b", "z-ai/glm-4.6", "glm-4.6"]) {
      const cost = computeCallCostPaise(modelId, { promptTokens: 1000, completionTokens: 500 });
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
  });

  it("providerForModel reports the real provider behind each known model, undefined for an unknown one", () => {
    expect(providerForModel("openai/gpt-oss-20b")).toBe("groq");
    expect(providerForModel("gemini-3.6-flash")).toBe("gemini");
    expect(providerForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe("nvidia");
    expect(providerForModel("z-ai/glm-4.6")).toBe("openrouter");
    expect(providerForModel("glm-4.6")).toBe("zai");
    expect(providerForModel("not-a-real-model")).toBeUndefined();
  });
});
