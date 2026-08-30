/**
 * The buyer agent's own deterministic ceilings — code, never the model,
 * per CLAUDE.md's "AI decides judgment, code decides limits" applied to
 * this agent itself, not just the merchant platform it's testing. These
 * exist because an autonomous buyer with a bug (or a model that gets
 * enthusiastic) should never be able to hammer a real merchant's real
 * Razorpay account. This is the honest answer to "what stops your demo
 * agent from spending everything."
 */

export interface RunBounds {
  /** Reaching this ends the run as "exhausted" — a real outcome, never an error. */
  maxSteps: number;
  /** Hard wall-clock budget for the whole run, milliseconds. */
  maxRunMillis: number;
  /** Hard budget per individual tool call, milliseconds. */
  maxToolCallMillis: number;
  /** The agent may never call `purchase` more than this many times in one run, regardless of what the model wants. */
  maxPurchaseAttempts: number;
  /** Bounded retries on a rate-limit response before ending the run as "rate_limited". */
  maxRateLimitRetries: number;
  /** Base backoff between rate-limit retries, milliseconds (doubled each retry). */
  rateLimitBackoffBaseMillis: number;
  /**
   * A small pause between agent turns. Real pacing, not a workaround —
   * the merchant's own MCP endpoint rate-limits at 60 requests/minute
   * per agent (agent-auth.ts), and each ADK turn issues several HTTP
   * requests under the hood (tool discovery plus the call itself, once
   * per turn). A real buyer agent that thinks between actions paces
   * naturally within that budget; one with no pause at all can trip the
   * merchant's own limiter through framework chattiness alone, which
   * isn't one of this layer's named refusal scenarios.
   */
  interTurnPauseMillis: number;
}

export const DEFAULT_RUN_BOUNDS: RunBounds = {
  maxSteps: 25,
  maxRunMillis: 5 * 60_000,
  maxToolCallMillis: 20_000,
  maxPurchaseAttempts: 5,
  maxRateLimitRetries: 3,
  rateLimitBackoffBaseMillis: 4_000,
  // Gemini's real free tier caps gemini-3.5-flash at 20 requests/minute
  // (observed live, 2026-08-30) — 3s of spacing keeps a multi-turn run
  // under that ceiling without relying on retries to paper over it.
  interTurnPauseMillis: 3_000,
};

export type RunOutcome = "succeeded" | "exhausted" | "timed_out" | "rate_limited" | "error";

/** Pure function: has this run exceeded a ceiling? Called by the loop before every step — never asked of the model. */
export function checkCeilings(
  bounds: RunBounds,
  state: { stepCount: number; purchaseAttempts: number; startedAtMs: number; nowMs: number },
): RunOutcome | null {
  if (state.nowMs - state.startedAtMs > bounds.maxRunMillis) return "timed_out";
  if (state.stepCount >= bounds.maxSteps) return "exhausted";
  if (state.purchaseAttempts > bounds.maxPurchaseAttempts) return "exhausted";
  return null;
}
