/**
 * Layer 14-4: real, sourced per-token pricing for every model this
 * codebase actually calls (llm.ts's GROQ_MODEL/GEMINI_MODEL, and
 * ai-credits.ts's seeded tiers). This is the ONE place a rupee figure
 * for a model call is allowed to originate from a hardcoded constant
 * rather than a live query — because a token's price is a fact about
 * the outside world, not something this app's own data can derive. It
 * is a snapshot of published, publicly listed pricing at the time this
 * layer was built, not a live-fetched rate; a real production system
 * would refresh this against each provider's pricing API periodically.
 * Never estimated, never invented — see CLAUDE.md's no-fabricated-data
 * discipline and DECISIONS.md for the "simulation" framing this whole
 * layer states honestly.
 *
 * Sources (August 2026):
 *  - Groq openai/gpt-oss-20b:  $0.075 / $0.30 per 1M input/output tokens
 *  - Groq openai/gpt-oss-120b: $0.15  / $0.60 per 1M input/output tokens
 *  - Gemini 3.6 Flash:         $0.75  / $3.75 per 1M input/output tokens
 *    (Google's own standard-tier rate through 2026-12-31)
 *
 * INR conversion uses a fixed illustrative rate (see USD_TO_INR_PAISE
 * below) — real-time FX is out of scope and would just be another
 * number this project can't honestly claim to source live.
 */

export const USD_TO_INR_PAISE = 8_800; // ₹88.00/USD, paise — a fixed illustrative rate, not a live FX feed

interface ModelPricing {
  provider: "groq" | "gemini";
  /** USD, per 1,000,000 tokens. */
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "openai/gpt-oss-20b": { provider: "groq", inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  "openai/gpt-oss-120b": { provider: "groq", inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "gemini-3.6-flash": { provider: "gemini", inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
};

export function isKnownModel(modelId: string): boolean {
  return modelId in MODEL_PRICING;
}

export function listKnownModelIds(): string[] {
  return Object.keys(MODEL_PRICING);
}

/**
 * Integer-paise cost of one real call, from its real token counts. Never
 * a float: converts to paise-per-million-tokens first (itself rounded
 * to the nearest paise, the one unavoidable rounding point since a
 * sourced USD rate is not itself an integer), then does integer
 * multiplication and division only.
 */
export function computeCallCostPaise(modelId: string, usage: { promptTokens: number; completionTokens: number }): number {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) {
    throw new Error(`computeCallCostPaise: no pricing known for model "${modelId}" — add it to MODEL_PRICING before routing calls to it`);
  }

  const inputPaisePerMillion = Math.round(pricing.inputPerMillionUsd * USD_TO_INR_PAISE);
  const outputPaisePerMillion = Math.round(pricing.outputPerMillionUsd * USD_TO_INR_PAISE);

  const inputCostPaise = Math.round((usage.promptTokens * inputPaisePerMillion) / 1_000_000);
  const outputCostPaise = Math.round((usage.completionTokens * outputPaisePerMillion) / 1_000_000);

  return inputCostPaise + outputCostPaise;
}
