import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The buyer's own append-only audit trail — deliberately mirroring the
 * shape of the merchant's audit_log, one JSON object per line, written
 * as the run happens rather than buffered and flushed at the end (a run
 * that crashes mid-way still leaves a real, inspectable log). This file
 * is what the theatre view (L19-5) reads and what a judge can inspect
 * afterward.
 */

export type RunLogEventType =
  | "run_started"
  | "step"
  | "tool_call"
  | "tool_result"
  | "run_ended";

export interface RunLogEntry {
  runId: string;
  stepIndex: number;
  type: RunLogEventType;
  timestamp: string;
  /** The model's stated reasoning for this step, when this entry is a step/tool_call. Real model output only — never fabricated or interpolated. */
  reasoning?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  /** Present on a tool_result whose result carried a real money action id — the join key the theatre view correlates against (never a timestamp). */
  moneyActionId?: string;
  outcome?: string;
  message?: string;
}

export class RunLog {
  private readonly path: string;
  private stepIndex = 0;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private write(entry: RunLogEntry) {
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
  }

  nextStepIndex(): number {
    return this.stepIndex++;
  }

  started(runId: string, goal: string) {
    this.write({ runId, stepIndex: -1, type: "run_started", timestamp: new Date().toISOString(), message: goal });
  }

  step(runId: string, stepIndex: number, reasoning: string) {
    this.write({ runId, stepIndex, type: "step", timestamp: new Date().toISOString(), reasoning });
  }

  toolCall(runId: string, stepIndex: number, toolName: string, toolArgs: unknown, reasoning?: string) {
    this.write({ runId, stepIndex, type: "tool_call", timestamp: new Date().toISOString(), toolName, toolArgs, reasoning });
  }

  toolResult(runId: string, stepIndex: number, toolName: string, toolResult: unknown, moneyActionId?: string) {
    this.write({ runId, stepIndex, type: "tool_result", timestamp: new Date().toISOString(), toolName, toolResult, moneyActionId });
  }

  ended(runId: string, outcome: string, message: string) {
    this.write({ runId, stepIndex: this.stepIndex, type: "run_ended", timestamp: new Date().toISOString(), outcome, message });
  }
}

/** Extracts a real money action id from a tool result, if one is present — never inferred, only read from a field the server actually returned. */
export function extractMoneyActionId(toolResult: unknown): string | undefined {
  if (toolResult && typeof toolResult === "object" && "moneyActionId" in toolResult) {
    const value = (toolResult as { moneyActionId?: unknown }).moneyActionId;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
