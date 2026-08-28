/**
 * Real Groq model ids, verified live against Groq's own /models
 * endpoint before being hardcoded here (see FAILURES.md / DECISIONS.md)
 * — never a placeholder or another vendor's name. A merchant picks
 * from this real, checkable list; they cannot type an arbitrary model
 * id, which would risk a tier nothing can actually serve.
 *
 * Not in actions.ts: a "use server" file may only export async
 * functions, and this is a plain const array both the server action
 * and the page's own filtering logic need to import.
 */
export const TIER_PRESETS = [
  { modelId: "openai/gpt-oss-20b", displayName: "Groq — GPT-OSS 20B (fast)" },
  { modelId: "qwen/qwen3.8-27b", displayName: "Groq — Qwen3 27B" },
  { modelId: "openai/gpt-oss-120b", displayName: "Groq — GPT-OSS 120B (largest)" },
] as const;
