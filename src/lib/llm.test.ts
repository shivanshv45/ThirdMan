import { describe, it, expect } from "vitest";
import { complete, completeStructured } from "@/lib/llm";
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
