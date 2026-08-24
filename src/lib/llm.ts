import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "@/lib/env";

/**
 * The only sanctioned way to call an LLM in this codebase. Feature code
 * never imports groq-sdk or @google/generative-ai directly.
 *
 * Groq is the default for everything. Gemini is reserved for tasks that
 * pass `needsHardReasoning: true` and hits its free-tier rate limit fast,
 * so every Gemini call falls back to Groq on any failure.
 *
 * This module must never be asked to do arithmetic on money. Spend caps,
 * balances, and bounds are deterministic code, not LLM output. See
 * CLAUDE.md, "AI decides judgment. Code decides limits."
 */

const CALL_TIMEOUT_MS = 15_000;

const GROQ_MODEL = "openai/gpt-oss-20b";
const GEMINI_MODEL = "gemini-3.6-flash";

const groq = new Groq({ apiKey: env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export type LlmProvider = "groq" | "gemini";

export interface CompletionInput {
  prompt: string;
  systemPrompt?: string;
  /** Set only for tasks that genuinely need stronger reasoning than Groq reliably provides. */
  needsHardReasoning?: boolean;
}

export interface CompletionResult {
  text: string;
  provider: LlmProvider;
}

function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`LLM call "${label}" timed out after ${CALL_TIMEOUT_MS}ms`)),
        CALL_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function callGroq(input: CompletionInput): Promise<string> {
  const completion = await withTimeout(
    "groq.chat.completions.create",
    groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        ...(input.systemPrompt
          ? [{ role: "system" as const, content: input.systemPrompt }]
          : []),
        { role: "user" as const, content: input.prompt },
      ],
    }),
  );

  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("Groq returned an empty completion");
  return text;
}

async function callGemini(input: CompletionInput): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    ...(input.systemPrompt ? { systemInstruction: input.systemPrompt } : {}),
  });
  const result = await withTimeout(
    "gemini.generateContent",
    model.generateContent(input.prompt),
  );

  const text = result.response.text();
  if (!text) throw new Error("Gemini returned an empty completion");
  return text;
}

/**
 * A model call failing must never crash a money path. Callers on a money
 * path must treat a rejected promise from this function as "no answer"
 * and take the deterministic default, which is deny.
 */
export async function complete(input: CompletionInput): Promise<CompletionResult> {
  if (input.needsHardReasoning) {
    try {
      const text = await callGemini(input);
      return { text, provider: "gemini" };
    } catch (err) {
      console.warn("[llm] Gemini failed, falling back to Groq:", err);
      // fall through to Groq below
    }
  }

  const text = await callGroq(input);
  return { text, provider: "groq" };
}

/**
 * Structured variant for classification tasks. Retries once on a parse
 * failure, then fails cleanly rather than returning malformed data.
 * Callers must not receive a value that only half-matches the schema.
 */
export async function completeStructured<T>(
  input: CompletionInput & { schema: z.ZodType<T>; schemaDescription: string },
): Promise<{ data: T; provider: LlmProvider }> {
  const structuredPrompt = `${input.prompt}\n\nRespond with ONLY valid JSON matching this shape, no markdown fences, no commentary: ${input.schemaDescription}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ ...input, prompt: structuredPrompt });
    try {
      const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, "");
      const parsed = input.schema.parse(JSON.parse(cleaned));
      return { data: parsed, provider: result.provider };
    } catch (err) {
      if (attempt === 1) {
        throw new Error(
          `LLM structured output failed validation after retry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.warn("[llm] Structured output failed to parse, retrying once:", err);
    }
  }

  // Unreachable, the loop above always returns or throws.
  throw new Error("completeStructured: unreachable");
}
