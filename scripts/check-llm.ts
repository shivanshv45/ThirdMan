import { complete, completeStructured } from "@/lib/llm";
import { z } from "zod";

async function checkGroqDefault() {
  const result = await complete({ prompt: "Reply with exactly one word: OK" });
  console.log("Default (no hint) routed to:", result.provider, "-", result.text.trim());
  if (result.provider !== "groq") throw new Error("Expected default routing to Groq");
}

async function checkGeminiOnHint() {
  const result = await complete({
    prompt: "Reply with exactly one word: OK",
    needsHardReasoning: true,
  });
  console.log("Hard-reasoning hint routed to:", result.provider, "-", result.text.trim());
  if (result.provider !== "gemini") throw new Error("Expected hard-reasoning routing to Gemini");
}

async function checkStructuredOutput() {
  const schema = z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) });
  const result = await completeStructured({
    prompt: "Classify the sentiment of: 'This product is amazing!'",
    schema,
    schemaDescription: '{ "sentiment": "positive" | "negative" | "neutral" }',
  });
  console.log("Structured output:", result.data, "via", result.provider);
  if (result.data.sentiment !== "positive") {
    throw new Error(`Expected positive sentiment, got ${result.data.sentiment}`);
  }
}

async function main() {
  await checkGroqDefault();
  await checkGeminiOnHint();
  await checkStructuredOutput();
  console.log("All LLM wrapper checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("LLM check FAILED:", err);
    process.exit(1);
  });
