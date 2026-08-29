import { trace, context, createContextKey, SpanStatusCode, type Span, type Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * The only file that touches @opentelemetry/api directly — feature code
 * calls withSpan()/getSpansForMoneyAction(), never the SDK itself. Same
 * "one sanctioned wrapper" pattern as llm.ts and razorpay.ts.
 *
 * Layer 15: spans exist to make one decision's own timing inspectable
 * (the waterfall on /dashboard/explain), not to stand up a general
 * observability stack. There is no external collector — CapturedSpanStore
 * below is the entire "backend," an in-memory ring buffer scoped to this
 * process. A span is only ever available for as long as the process has
 * been running and hasn't rotated it out — see ARCHITECTURE.md.
 */

const TRACER_NAME = "thirdman";

export interface CapturedSpan {
  name: string;
  startTimeMs: number;
  durationMs: number;
  attributes: Attributes;
  ok: boolean;
  errorMessage?: string;
}

const MAX_TRACKED_ACTIONS = 500;

/**
 * Keyed by moneyActionId. A plain Map used as an LRU-by-insertion-order
 * ring buffer: the oldest key is evicted once the map exceeds
 * MAX_TRACKED_ACTIONS, bounding memory in a long-running process without
 * needing a real cache dependency.
 */
class CapturedSpanStore {
  private readonly byMoneyAction = new Map<string, CapturedSpan[]>();

  record(moneyActionId: string, span: CapturedSpan): void {
    const existing = this.byMoneyAction.get(moneyActionId);
    if (existing) {
      existing.push(span);
      return;
    }

    if (this.byMoneyAction.size >= MAX_TRACKED_ACTIONS) {
      const oldestKey = this.byMoneyAction.keys().next().value;
      if (oldestKey !== undefined) this.byMoneyAction.delete(oldestKey);
    }
    this.byMoneyAction.set(moneyActionId, [span]);
  }

  get(moneyActionId: string): CapturedSpan[] {
    return [...(this.byMoneyAction.get(moneyActionId) ?? [])].sort((a, b) => a.startTimeMs - b.startTimeMs);
  }
}

// A module-level singleton survives across requests within one server
// process — the only scope an in-memory store can meaningfully have here.
const store = new CapturedSpanStore();

/**
 * Registered as a spanProcessor alongside @vercel/otel's own default
 * processor in instrumentation.ts (additive, not a replacement — default
 * Next.js span export is untouched). Only spans carrying a moneyActionId
 * attribute are captured; every other span Next.js/the SDK emits is
 * ignored here, which is what keeps this "spans around exactly the money
 * path," not blanket auto-instrumentation.
 */
export class MoneyPathCaptureProcessor implements SpanProcessor {
  onStart(): void {
    // Nothing to do on start — captured at onEnd once duration is known.
  }

  onEnd(span: ReadableSpan): void {
    const moneyActionId = span.attributes["thirdman.money_action_id"];
    if (typeof moneyActionId !== "string" || !moneyActionId) return;

    const [startSeconds, startNanos] = span.startTime;
    const [endSeconds, endNanos] = span.endTime;
    const startTimeMs = startSeconds * 1000 + startNanos / 1e6;
    const durationMs = endSeconds * 1000 + endNanos / 1e6 - startTimeMs;

    store.record(moneyActionId, {
      name: span.name,
      startTimeMs,
      durationMs,
      attributes: span.attributes,
      ok: span.status.code !== SpanStatusCode.ERROR,
      errorMessage: span.status.code === SpanStatusCode.ERROR ? span.status.message : undefined,
    });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A mutable box carried through OTel's async context. Mandate
 * verification, the capability check, and every checkBounds sub-step all
 * run BEFORE money_actions has a row, so none of them can be tagged with
 * a moneyActionId directly at span-creation time. Instead every step
 * within one attemptMoneyAction call (or its pre-gate callers, once they
 * also wrap themselves in withMoneyPathSpan) shares this one box via
 * context propagation; the box is filled in once the id exists
 * (setCorrelatedMoneyActionId), and withSpan reads it back when each
 * child span ends — so a step that ran before the id existed still ends
 * up correctly tagged, as long as it ends after the box is filled.
 */
const CORRELATION_KEY = createContextKey("thirdman.money_action_correlation");

interface CorrelationBox {
  moneyActionId?: string;
}

/**
 * Opens the root span for one full money-path attempt and gives every
 * span nested under fn (via withSpan) a shared CorrelationBox to write
 * the real moneyActionId into once it's known. Callers that run pre-gate
 * checks (mandate verification, capability) and then call
 * attemptMoneyAction should wrap the whole sequence in this so their
 * spans land in the same trace as the gate's own.
 *
 * Reuses an already-active CorrelationBox if one exists in context
 * (nested call, e.g. attemptMoneyAction itself always opens one — a
 * caller that already wrapped the request doesn't get two boxes with
 * two independent "the id is now known" states) rather than starting a
 * fresh one, so a route handler wrapping mandate verification + the
 * purchase call in one span nests correctly under gate.ts's own.
 */
export async function withMoneyPathSpan<T>(
  name: string,
  fn: (setMoneyActionId: (id: string) => void) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const existingBox = context.active().getValue(CORRELATION_KEY) as CorrelationBox | undefined;
  const box: CorrelationBox = existingBox ?? {};
  const ctx = existingBox ? context.active() : context.active().setValue(CORRELATION_KEY, box);

  return context.with(ctx, () =>
    tracer.startActiveSpan(name, async (span) => {
      if (box.moneyActionId) span.setAttribute("thirdman.money_action_id", box.moneyActionId);
      try {
        const result = await fn((id) => {
          box.moneyActionId = id;
          span.setAttribute("thirdman.money_action_id", id);
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        if (box.moneyActionId) span.setAttribute("thirdman.money_action_id", box.moneyActionId);
        span.end();
      }
    }),
  );
}

/**
 * Wraps one money-path step in a child span. Reads the current
 * CorrelationBox (set by the nearest enclosing withMoneyPathSpan) at
 * span-end time, so a step tagged before the moneyActionId existed still
 * ends up correctly attributed once it's known — see withMoneyPathSpan's
 * docstring. Outside any withMoneyPathSpan, the span simply carries no
 * moneyActionId and is never captured by MoneyPathCaptureProcessor
 * (never a correctness issue — the processor only reads the attribute,
 * it doesn't gate anything).
 *
 * A span failing to capture, or the OTel SDK misbehaving, must never
 * affect the money path itself — errors from span bookkeeping never
 * propagate, while fn's own errors always do, unchanged.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      const box = context.active().getValue(CORRELATION_KEY) as CorrelationBox | undefined;
      if (box?.moneyActionId) span.setAttribute("thirdman.money_action_id", box.moneyActionId);
      span.end();
    }
  });
}

/** Reads back every captured step for one decision, oldest first — what the waterfall renders. Empty array if none were captured (a decision predating this layer, or since evicted). */
export function getSpansForMoneyAction(moneyActionId: string): CapturedSpan[] {
  return store.get(moneyActionId);
}
