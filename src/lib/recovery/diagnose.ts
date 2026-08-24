import { z } from "zod";
import { completeStructured } from "@/lib/llm";
import type { paymentFailures } from "@/lib/db/schema";

/**
 * A closed set the policy in policy.ts switches on exhaustively. The model
 * in diagnoseFailure picks FROM this set — it never invents a category —
 * because an unrecognised string would fall through a policy branch with
 * no defined behaviour. See CLAUDE.md, "AI decides judgment. Code decides
 * limits."
 */
export const DECLINE_CATEGORIES = [
  "insufficient_funds",
  "issuer_declined",
  "expired_card",
  "invalid_instrument",
  "technical_failure",
  "suspected_fraud",
  "customer_abandoned",
  "unknown",
] as const;

export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

export interface Diagnosis {
  rootCause: string;
  category: DeclineCategory;
  recoverable: boolean;
  confidence: "high" | "low";
  source: "model" | "deterministic_fallback";
}

type PaymentFailureRow = typeof paymentFailures.$inferSelect;

/**
 * A small closed vocabulary of Razorpay's own decline codes is something
 * a lookup table handles better than a model — unlike risk.ts's fallback,
 * which only kicks in when the model is unreachable, this table is
 * consulted FIRST and the model is only asked about codes it doesn't
 * cover. Codes and descriptions are matched case-insensitively against
 * substrings actually seen in Razorpay's error_description field.
 */
const KNOWN_DECLINE_PATTERNS: Array<{
  match: (code: string, description: string) => boolean;
  category: DeclineCategory;
  recoverable: boolean;
  rootCause: string;
}> = [
  {
    match: (_c, d) => d.includes("insufficient funds"),
    category: "insufficient_funds",
    recoverable: true,
    rootCause: "The customer's account did not have enough funds at the time of payment.",
  },
  {
    match: (_c, d) => d.includes("expired"),
    category: "expired_card",
    recoverable: true,
    rootCause: "The card used had already expired.",
  },
  {
    match: (_c, d) => d.includes("stolen") || d.includes("lost card") || d.includes("invalid card number") || d.includes("do not honor") || d.includes("pick up card"),
    category: "invalid_instrument",
    recoverable: false,
    rootCause: "The card is invalid, reported lost/stolen, or the issuer refused to honor it — the same instrument cannot be retried.",
  },
  {
    match: (_c, d) => d.includes("declined by the issuing bank") || d.includes("declined by the bank"),
    category: "issuer_declined",
    recoverable: true,
    rootCause: "The issuing bank declined the payment. Often recoverable on a different instrument.",
  },
  {
    match: (c) => c === "GATEWAY_TIMEOUT_ERROR" || c === "SERVER_ERROR",
    category: "technical_failure",
    recoverable: true,
    rootCause: "The payment failed due to a transient gateway or network issue, not a decision by the bank.",
  },
  {
    match: (_c, d) => d.includes("fraud") || d.includes("suspicious"),
    category: "suspected_fraud",
    recoverable: false,
    rootCause: "The payment was flagged as potentially fraudulent. This must go to a human, never retried automatically.",
  },
];

/**
 * Consulted only when the deterministic table above doesn't cover the
 * code. Fails closed (CLAUDE.md rule 4): a model failure here means the
 * failure is treated as unrecoverable, never as "try anyway."
 */
const diagnosisSchema = z.object({
  category: z.enum(DECLINE_CATEGORIES),
  recoverable: z.boolean(),
  rootCause: z.string().min(1),
});

function deterministicUnknown(): Diagnosis {
  return {
    rootCause: "This decline code and description did not match any known pattern, and no diagnosis could be made. Treated as unrecoverable rather than guessed.",
    category: "unknown",
    recoverable: false,
    confidence: "low",
    source: "deterministic_fallback",
  };
}

export async function diagnoseFailure(failure: PaymentFailureRow): Promise<Diagnosis> {
  const code = (failure.declineCode ?? "").toUpperCase();
  const description = (failure.declineDescription ?? "").toLowerCase();

  const tableMatch = KNOWN_DECLINE_PATTERNS.find((p) => p.match(code, description));
  if (tableMatch) {
    return {
      rootCause: tableMatch.rootCause,
      category: tableMatch.category,
      recoverable: tableMatch.recoverable,
      confidence: "high",
      source: "deterministic_fallback",
    };
  }

  try {
    const result = await completeStructured({
      prompt: `A payment failed with this information from Razorpay:
- Decline code: "${failure.declineCode}"
- Description: "${failure.declineDescription ?? "(none provided)"}"
- Amount: ₹${(failure.amountPaise / 100).toFixed(2)}

Classify this decline into exactly one category from the closed list, decide whether it is realistically recoverable by retrying or offering an alternate payment method, and write one merchant-legible sentence explaining the root cause in plain English (not a restatement of the code).

Categories: ${DECLINE_CATEGORIES.join(", ")}.

If nothing fits confidently, use "unknown" and set recoverable to false.`,
      schema: diagnosisSchema,
      schemaDescription: '{ "category": "<one of the listed categories>", "recoverable": true | false, "rootCause": "one sentence" }',
    });

    return {
      rootCause: result.data.rootCause,
      category: result.data.category,
      recoverable: result.data.recoverable,
      confidence: "high",
      source: "model",
    };
  } catch (err) {
    console.warn("[diagnose] Model classification failed, failing closed to unknown/unrecoverable:", err);
    return deterministicUnknown();
  }
}
