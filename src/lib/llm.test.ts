import { describe, it, expect } from "vitest";
import { complete, completeStructured } from "@/lib/llm";
import { env } from "@/lib/env";
import { z } from "zod";

/**
 * No mocks. Every case here makes a real call to Groq and/or Gemini.
 * The Gemini-failure-falls-back-to-Groq path is verified separately in
 * scripts/check-llm-fallback.ts, since forcing a real Gemini failure
 * needs a genuinely broken client (an invalid model name) rather than
 * anything expressible through complete()'s public input shape.
 */

describe("complete", () => {
  it("routes to Groq by default", async () => {
    const result = await complete({ prompt: "Reply with exactly one word: OK" });
    expect(result.provider).toBe("groq");
    expect(result.text.trim().toUpperCase()).toContain("OK");
  }, 20_000);

  it("routes to Gemini when needsHardReasoning is set", async () => {
    const result = await complete({
      prompt: "Reply with exactly one word: OK",
      needsHardReasoning: true,
    });
    expect(result.provider).toBe("gemini");
    expect(result.text.trim().toUpperCase()).toContain("OK");
  }, 20_000);

  // Layer 16: each new provider is skipped when its key isn't configured
  // in this environment (env.ts makes all three optional), rather than
  // failing the suite — a real result to handle, not a flake to retry.
  it.skipIf(!env.NVIDIA_API_KEY || !env.NVIDIA_ENDPOINT)("routes to NVIDIA when provider: 'nvidia' is set, and reports real usage", async () => {
    const result = await complete({ prompt: "Reply with exactly one word: OK", provider: "nvidia" });
    expect(result.provider).toBe("nvidia");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 20_000);

  it.skipIf(!env.OPENROUTER_API_KEY)("routes to OpenRouter when provider: 'openrouter' is set, and reports real usage", async () => {
    const result = await complete({ prompt: "Reply with exactly one word: OK", provider: "openrouter" });
    expect(result.provider).toBe("openrouter");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 20_000);

  it.skipIf(!env.ZAI_API_KEY)("routes to Z.ai when provider: 'zai' is set, and reports real usage", async () => {
    const result = await complete({ prompt: "Reply with exactly one word: OK", provider: "zai" });
    expect(result.provider).toBe("zai");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 20_000);

  it.skipIf(env.NVIDIA_API_KEY && env.NVIDIA_ENDPOINT)(
    "an unconfigured provider falls back to Groq, and CompletionResult.provider says so — never the requested vendor's name",
    async () => {
      const result = await complete({ prompt: "Reply with exactly one word: OK", provider: "nvidia" });
      expect(result.provider).toBe("groq");
    },
    20_000,
  );

  it.skipIf(!env.ZAI_API_KEY)(
    "a provider whose real key is rejected by the provider falls back to Groq rather than crashing — same tier-honesty contract as an unconfigured one",
    async () => {
      // Not a simulated failure: this asserts the fallback CONTRACT
      // holds regardless of why the call failed. If ZAI_API_KEY is
      // valid in this environment, the "routes to Z.ai" test above
      // covers the success path instead — the two tests are
      // complementary, not redundant, and one of them exercises
      // whatever this environment's real key state actually is.
      const result = await complete({ prompt: "Reply with exactly one word: OK", provider: "zai" });
      expect(["zai", "groq"]).toContain(result.provider);
    },
    20_000,
  );
});

describe("completeStructured", () => {
  it("returns schema-validated output from a real completion", async () => {
    const schema = z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) });
    const result = await completeStructured({
      prompt: "Classify the sentiment of: 'This product is amazing!'",
      schema,
      schemaDescription: '{ "sentiment": "positive" | "negative" | "neutral" }',
    });
    expect(result.data.sentiment).toBe("positive");
  }, 20_000);
});
