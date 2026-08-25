import { z } from "zod";
import { completeStructured } from "@/lib/llm";

/**
 * Suggests a product description for a thin/missing one (Layer 5-6). The
 * one genuinely good LLM job in the readiness scorer — CLAUDE.md rule 2's
 * "LLM is appropriate" column, drafting customer-facing copy. Never
 * writes to the database itself: the caller shows this as a draft the
 * merchant edits and accepts, same proposal-not-decision pattern as
 * catalogue-import.ts and chat.ts's applyIntent.
 */

const suggestionSchema = z.object({ description: z.string().min(1).max(500) });

export async function suggestProductDescription(input: {
  name: string;
  category: string;
  existingDescription: string;
  attributes: Record<string, string>[];
}): Promise<string> {
  const attributesText = input.attributes.length > 0
    ? input.attributes.map((a) => Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(", ")).join("; ")
    : "none given";

  const { data } = await completeStructured({
    prompt: `Write a concise, honest product description (1-2 sentences, under 300 characters) for a merchant's catalogue listing, based only on the real facts given below. Do not invent features, materials, or claims not implied by the name/attributes.

Product name: "${input.name}"
Category: ${input.category}
Variant attributes across this product's variants: ${attributesText}
Current description (may be thin or empty): "${input.existingDescription}"`,
    schema: suggestionSchema,
    schemaDescription: '{ "description": string }',
  });

  return data.description.trim();
}
