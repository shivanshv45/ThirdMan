import { z } from "zod";
import { completeStructured } from "@/lib/llm";
import type { UnifiedDecision } from "@/lib/explainability";

/**
 * The layer's one legitimate LLM job: explain an already-recorded
 * decision in plain language. Never asked whether the decision was
 * correct, never asked what should happen instead, never given anything
 * beyond one decision's own recorded fields. See
 * plans/layer-7-explainability-refusal-log.md, "Read this first" #3 and
 * "The one rule" — this module explains, it does not decide.
 *
 * The generated text is never persisted anywhere. The recorded `reason`
 * on the UnifiedDecision stays the authoritative record; this is a
 * reading aid over it, always rendered alongside it, never in place of
 * it.
 */

const explanationSchema = z.object({ explanation: z.string().min(1).max(600) });

export interface DecisionExplanation {
  explanation: string;
  /** False when the model call failed and the caller should show the raw record alone. */
  available: boolean;
}

/**
 * Every number the model is allowed to reference is handed as an
 * isolated, explicitly-labelled fact line — never embedded in prose —
 * and the prompt states outright that these numbers are authoritative
 * and must be repeated verbatim, not recomputed or paraphrased. This is
 * the exact fix FAILURES.md records for chat.ts's Layer 5-7 bug (a small
 * model paraphrasing a fact given mid-paragraph into a wrong number);
 * reused here rather than rediscovered.
 */
function buildFactSheet(decision: UnifiedDecision): string {
  const lines = [
    `SOURCE: ${decision.source}`,
    `KIND: ${decision.kind === "refusal" ? "the system declined to act" : "the system deferred to a human"}`,
    `DETERMINISM: ${decision.determinism === "deterministic" ? "pure arithmetic/rule, no model involved" : "a model's judgment contributed"}`,
    `BOUND OR RULE: ${decision.boundLabel}`,
    `RECORDED REASON (authoritative, quote or closely paraphrase, never contradict): "${decision.reason}"`,
  ];
  for (const a of decision.arithmetic) {
    lines.push(`FACT — ${a.label}: ${a.value} (authoritative, state exactly this value if you mention it, never a different number)`);
  }
  return lines.join("\n");
}

/**
 * Explains one recorded decision for a merchant reading the dashboard.
 * Degrades to { available: false } on any model failure — a different
 * fail-closed than the gate's (which denies) and the offer engine's
 * (which shows no offer): here, "closed" means show the complete
 * recorded truth without the plain-language layer, never a crash or a
 * blank panel.
 */
export async function explainDecision(decision: UnifiedDecision): Promise<DecisionExplanation> {
  const factSheet = buildFactSheet(decision);

  try {
    const { data } = await completeStructured({
      prompt: `A merchant is looking at one decision this system made automatically. Explain it in one short, plain paragraph (2-3 sentences) a non-technical shop owner would understand — no jargon, no bound identifiers, no code terms.

${factSheet}

Rules:
- Use ONLY the facts above. Never invent a number, a policy, or a reason not given here.
- Every number you state must be copied exactly from a FACT line above — never recomputed, rounded differently, or restated as a different figure.
- Do not suggest what the merchant should do about it (no advice, no recommendation to change any setting).
- Do not say whether the decision was right or wrong — only explain why it happened.
- If DETERMINISM says a model was involved, say so plainly ("an AI judged this request looked unusual" or similar) — if it says pure arithmetic, say that plainly too ("this was a fixed rule, not a judgment call").`,
      schema: explanationSchema,
      schemaDescription: '{ "explanation": string }',
    });

    return { explanation: data.explanation.trim(), available: true };
  } catch (err) {
    console.warn("[explain-decision] Model call failed, degrading to the recorded record alone:", err);
    return { explanation: "", available: false };
  }
}
