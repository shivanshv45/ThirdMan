import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "@/lib/env";
import { withSpan } from "@/lib/tracing";

/**
 * The only sanctioned way to call an LLM in this codebase. Feature code
 * never imports groq-sdk, @google/generative-ai, or any other provider
 * SDK directly, and never fetches a provider's HTTP endpoint itself.
 *
 * Groq is the default for everything. Gemini is reserved for tasks that
 * pass `needsHardReasoning: true` and hits its free-tier rate limit fast,
 * so every Gemini call falls back to Groq on any failure.
 *
 * Layer 16 widens the provider set to include NVIDIA NIM, OpenRouter,
 * and Z.ai — all three expose an OpenAI-compatible /chat/completions
 * endpoint, so they share one HTTP call path (callOpenAiCompatible)
 * rather than three more SDKs (CLAUDE.md: "No new dependency without a
 * clear reason it can't be done with what's installed"). None of the
 * three is ever requested directly by feature code — model-router.ts is
 * the only caller that names a specific non-default provider, and every
 * such request still falls back to Groq on failure, same as Gemini.
 *
 * This module must never be asked to do arithmetic on money. Spend caps,
 * balances, and bounds are deterministic code, not LLM output. See
 * CLAUDE.md, "AI decides judgment. Code decides limits."
 */

const CALL_TIMEOUT_MS = 15_000;

const GROQ_MODEL = "openai/gpt-oss-20b";
const GEMINI_MODEL = "gemini-3.6-flash";
const NVIDIA_MODEL = "nvidia/nemotron-3-nano-30b-a3b";
const OPENROUTER_MODEL = "z-ai/glm-4.6";
const ZAI_MODEL = "glm-4.6";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

// Lazy singletons rather than constructed at module load: this file is
// imported by enough routes that it can end up in the graph Next.js
// statically walks during a build's page-data collection step, before
// any request (and before a build environment necessarily has real
// provider keys) — see src/lib/env.ts's own lazy-proxy fix for the same
// class of issue. Constructing the client on first real call instead
// keeps every existing call site unchanged.
let _groq: Groq | undefined;
function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: env.GROQ_API_KEY });
  return _groq;
}

let _genAI: GoogleGenerativeAI | undefined;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return _genAI;
}

export type LlmProvider = "groq" | "gemini" | "nvidia" | "openrouter" | "zai";

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
  /**
   * Layer 16: routes this one call to a specific non-default provider —
   * only model-router.ts sets this, never feature code directly (routing
   * decisions belong to the router, not scattered across call sites).
   * Omitted, this function's existing needsHardReasoning/Groq-default
   * behavior is completely unchanged. A named provider that fails still
   * falls back to Groq, exactly like needsHardReasoning's Gemini path —
   * CompletionResult.provider always reports who actually served the
   * call, never the one that was requested (DECISIONS.md's tier-honesty
   * rule, generalized past Groq/Gemini to all five providers).
   */
  provider?: "nvidia" | "openrouter" | "zai";
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
      getGroq().chat.completions.create({
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
    const model = getGenAI().getGenerativeModel({
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

interface OpenAiCompatibleUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAiCompatibleResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: OpenAiCompatibleUsage;
  model?: string;
}

/**
 * Layer 16: NVIDIA NIM, OpenRouter, and Z.ai all expose the same
 * OpenAI-compatible /chat/completions shape, so this one function
 * serves all three rather than three separate SDK integrations — verify
 * a provider's response shape against its own docs before routing to
 * it; this assumes the standard shape and does not paper over a
 * divergence.
 */
async function callOpenAiCompatible(
  provider: "nvidia" | "openrouter" | "zai",
  baseUrl: string,
  apiKey: string,
  modelId: string,
  input: CompletionInput,
): Promise<{ text: string; usage?: TokenUsage; modelId: string }> {
  return withSpan("chat", { "gen_ai.system": provider, "gen_ai.request.model": modelId }, async (span) => {
    const response = await withTimeout(
      `${provider}.chat.completions.create`,
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
            { role: "user" as const, content: input.prompt },
          ],
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${provider} returned ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = (await response.json()) as OpenAiCompatibleResponse;
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${provider} returned an empty completion`);

    const usage = data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined;
    if (usage) {
      span.setAttribute("gen_ai.usage.input_tokens", usage.promptTokens);
      span.setAttribute("gen_ai.usage.output_tokens", usage.completionTokens);
    }
    // The response's own reported model id, when present, over the
    // requested one — some brokers (OpenRouter) can resolve a request
    // to a specific upstream variant, and model-router.ts's cost
    // bookkeeping must key off what actually served the call.
    const servedModelId = data.model || modelId;
    span.setAttribute("gen_ai.response.model", servedModelId);
    return { text, usage, modelId: servedModelId };
  });
}

function callNvidia(input: CompletionInput): Promise<{ text: string; usage?: TokenUsage; modelId: string }> {
  if (!env.NVIDIA_API_KEY || !env.NVIDIA_ENDPOINT) {
    throw new Error("NVIDIA is not configured (NVIDIA_API_KEY/NVIDIA_ENDPOINT missing)");
  }
  return callOpenAiCompatible("nvidia", env.NVIDIA_ENDPOINT, env.NVIDIA_API_KEY, NVIDIA_MODEL, input);
}

function callOpenRouter(input: CompletionInput): Promise<{ text: string; usage?: TokenUsage; modelId: string }> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OpenRouter is not configured (OPENROUTER_API_KEY missing)");
  }
  return callOpenAiCompatible("openrouter", OPENROUTER_BASE_URL, env.OPENROUTER_API_KEY, OPENROUTER_MODEL, input);
}

function callZai(input: CompletionInput): Promise<{ text: string; usage?: TokenUsage; modelId: string }> {
  if (!env.ZAI_API_KEY) {
    throw new Error("Z.ai is not configured (ZAI_API_KEY missing)");
  }
  return callOpenAiCompatible("zai", ZAI_BASE_URL, env.ZAI_API_KEY, ZAI_MODEL, input);
}

/**
 * A model call failing must never crash a money path. Callers on a money
 * path must treat a rejected promise from this function as "no answer"
 * and take the deterministic default, which is deny.
 */
export async function complete(input: CompletionInput): Promise<CompletionResult> {
  if (input.provider) {
    try {
      const caller = input.provider === "nvidia" ? callNvidia : input.provider === "openrouter" ? callOpenRouter : callZai;
      const result = await caller(input);
      return { ...result, provider: input.provider };
    } catch (err) {
      console.warn(`[llm] ${input.provider} failed, falling back to Groq:`, err);
      // fall through to Groq below
    }
  }

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
