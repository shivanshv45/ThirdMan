import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "@/lib/env";
import { withSpan } from "@/lib/tracing";

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
  /**
   * Layer 11-8: overrides GROQ_MODEL for this one call — used by
   * ai-credits.ts to actually serve the model tier a buyer paid coins
   * for, rather than always serving the app's own default. Every
   * feature call site in this codebase omits this and gets GROQ_MODEL,
   * unchanged from before this field existed. Has no effect when
   * needsHardReasoning routes to Gemini instead.
   */
  groqModelOverride?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionResult {
  text: string;
  provider: LlmProvider;
  /** Real token counts as reported by the provider's own response — never estimated. Absent only if a provider genuinely omitted usage data. */
  usage?: TokenUsage;
  /** The model id that actually served this call — model-router.ts's real-cost bookkeeping keys off this, never the requested override. */
  modelId: string;
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

// Layer 15-1: span attribute names follow the OpenTelemetry GenAI semantic
// conventions (gen_ai.request.model / gen_ai.usage.*) so a model call's
// cost is a first-class, standard-shaped span attribute rather than a
// bespoke field — this is what the waterfall's "risk assessment ...
// groq/openai-gpt-oss-20b · 847 tokens · ₹0.83" row reads from. The real
// token counts and provider come from the response itself, same as the
// CompletionResult this function already returns; the span only makes
// them visible per-decision, it computes nothing new.
async function callGroq(input: CompletionInput): Promise<{ text: string; usage?: TokenUsage; modelId: string }> {
  const modelId = input.groqModelOverride ?? GROQ_MODEL;
  return withSpan("chat", { "gen_ai.system": "groq", "gen_ai.request.model": modelId }, async (span) => {
    const completion = await withTimeout(
      "groq.chat.completions.create",
      groq.chat.completions.create({
        model: modelId,
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
    const usage = completion.usage
      ? { promptTokens: completion.usage.prompt_tokens, completionTokens: completion.usage.completion_tokens }
      : undefined;
    if (usage) {
      span.setAttribute("gen_ai.usage.input_tokens", usage.promptTokens);
      span.setAttribute("gen_ai.usage.output_tokens", usage.completionTokens);
    }
    span.setAttribute("gen_ai.response.model", modelId);
    return { text, usage, modelId };
  });
}

async function callGemini(input: CompletionInput): Promise<{ text: string; usage?: TokenUsage; modelId: string }> {
  return withSpan("chat", { "gen_ai.system": "gemini", "gen_ai.request.model": GEMINI_MODEL }, async (span) => {
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
    const usageMetadata = result.response.usageMetadata;
    const usage = usageMetadata ? { promptTokens: usageMetadata.promptTokenCount, completionTokens: usageMetadata.candidatesTokenCount } : undefined;
    if (usage) {
      span.setAttribute("gen_ai.usage.input_tokens", usage.promptTokens);
      span.setAttribute("gen_ai.usage.output_tokens", usage.completionTokens);
    }
    span.setAttribute("gen_ai.response.model", GEMINI_MODEL);
    return { text, usage, modelId: GEMINI_MODEL };
  });
}

/**
 * A model call failing must never crash a money path. Callers on a money
 * path must treat a rejected promise from this function as "no answer"
 * and take the deterministic default, which is deny.
 */
export async function complete(input: CompletionInput): Promise<CompletionResult> {
  if (input.needsHardReasoning) {
    try {
      const result = await callGemini(input);
      return { ...result, provider: "gemini" };
    } catch (err) {
      console.warn("[llm] Gemini failed, falling back to Groq:", err);
      // fall through to Groq below
    }
  }

  const result = await callGroq(input);
  return { ...result, provider: "groq" };
}

/**
 * Structured variant for classification tasks. Retries once on a parse
 * failure, then fails cleanly rather than returning malformed data.
 * Callers must not receive a value that only half-matches the schema.
 */
export async function completeStructured<T>(
  input: CompletionInput & { schema: z.ZodType<T>; schemaDescription: string },
): Promise<{ data: T; provider: LlmProvider; usage?: TokenUsage; modelId: string }> {
  const structuredPrompt = `${input.prompt}\n\nRespond with ONLY valid JSON matching this shape, no markdown fences, no commentary: ${input.schemaDescription}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ ...input, prompt: structuredPrompt });
    try {
      const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, "");
      const parsed = input.schema.parse(JSON.parse(cleaned));
      return { data: parsed, provider: result.provider, usage: result.usage, modelId: result.modelId };
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
