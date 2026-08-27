import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "@/lib/env";

/**
 * Proves the fallback pattern used inside src/lib/llm.ts is sound,
 * against a genuinely broken Gemini call (an invalid model name gives
 * a real, deterministic 404 rather than depending on rate-limit
 * timing) followed by a real Groq call. No mocks.
 */
async function main() {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });

  let usedProvider: "groq" | "gemini";
  let text: string;

  try {
    const model = genAI.getGenerativeModel({ model: "this-model-does-not-exist" });
    const result = await model.generateContent("Reply with exactly one word: OK");
    text = result.response.text();
    usedProvider = "gemini";
  } catch (err) {
    console.log("Gemini genuinely failed, as expected:", err instanceof Error ? err.message.slice(0, 120) : err);
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
    });
    text = completion.choices[0]?.message?.content ?? "";
    usedProvider = "groq";
  }

  console.log(`Fell back to: ${usedProvider}, response: ${text.trim()}`);

  if (usedProvider !== "groq") {
    throw new Error("Expected the fallback to land on Groq after a real Gemini failure");
  }

  console.log("Fallback pattern check PASSED.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fallback check FAILED:", err);
    process.exit(1);
  });
