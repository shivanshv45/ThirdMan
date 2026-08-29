import { describe, it, expect } from "vitest";
import { withMoneyPathSpan, withSpan, getSpansForMoneyAction, MoneyPathCaptureProcessor } from "./tracing";
import { trace, context } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";

// Layer 16 fix: the installed @opentelemetry/sdk-trace-base version
// takes its span processors as a constructor option and registers
// itself as the global tracer provider via trace.setGlobalTracerProvider
// — BasicTracerProvider no longer has addSpanProcessor/register instance
// methods, and SpanProcessor lives in sdk-trace-base, not api. This
// mirrors src/instrumentation.ts's real registration (registerOTel's
// spanProcessors option), just without @vercel/otel's Next-specific
// wrapper, which this unit test doesn't need.
//
// A context manager also has to be registered explicitly here: in
// production, registerOTel installs @opentelemetry/context-async-hooks
// so context.with(...) survives an `await` boundary (real, load-bearing
// behavior — withSpan's finally block reads the active context after
// awaiting fn). Without one, the default no-op context manager drops
// that binding across the first await, and a child span never picks up
// its moneyActionId. @opentelemetry/context-async-hooks was already a
// real (if previously unreachable — see FAILURES.md) dependency of
// @vercel/otel, not a new capability; added as a direct devDependency so
// this test can register the same context manager production gets.
const provider = new BasicTracerProvider({ spanProcessors: [new MoneyPathCaptureProcessor()] });
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncHooksContextManager().enable());

describe("Layer 15 - OpenTelemetry Tracing", () => {
  it("should capture spans within a money path and record GenAI conventions", async () => {
    const moneyActionId = `ma_test_${Date.now()}_${Math.random()}`;

    await withMoneyPathSpan("attempt_money_action", async (setMoneyActionId) => {
      // Set the moneyActionId early as would happen if it's generated upfront
      setMoneyActionId(moneyActionId);

      await withSpan("mandate_verification", {}, async () => {
        // simulate work
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      await withSpan("risk_assessment", {
        "gen_ai.request.model": "groq/gpt-oss-20b",
        "gen_ai.usage.completion_tokens": 150,
        "gen_ai.usage.prompt_tokens": 50,
        "gen_ai.usage.cost_paise": 83,
      }, async () => {
        // simulate work
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    });

    const spans = getSpansForMoneyAction(moneyActionId);
    
    // Check that we captured exactly 3 spans
    expect(spans.length).toBe(3);

    const mandateSpan = spans.find((s) => s.name === "mandate_verification");
    const riskSpan = spans.find((s) => s.name === "risk_assessment");
    const rootSpan = spans.find((s) => s.name === "attempt_money_action");

    expect(mandateSpan).toBeDefined();
    expect(riskSpan).toBeDefined();
    expect(rootSpan).toBeDefined();

    // Verify GenAI conventions are recorded
    expect(riskSpan?.attributes["gen_ai.request.model"]).toBe("groq/gpt-oss-20b");
    expect(riskSpan?.attributes["gen_ai.usage.completion_tokens"]).toBe(150);
    expect(riskSpan?.attributes["gen_ai.usage.cost_paise"]).toBe(83);

    // Verify ok status
    expect(riskSpan?.ok).toBe(true);
    expect(mandateSpan?.ok).toBe(true);
  });

  it("should capture errors correctly", async () => {
    const moneyActionId = `ma_test_error_${Date.now()}_${Math.random()}`;

    await expect(
      withMoneyPathSpan("attempt_money_action", async (setMoneyActionId) => {
        setMoneyActionId(moneyActionId);

        await withSpan("failing_step", {}, async () => {
          throw new Error("Simulated failure");
        });
      })
    ).rejects.toThrow("Simulated failure");

    const spans = getSpansForMoneyAction(moneyActionId);
    
    const failingSpan = spans.find((s) => s.name === "failing_step");
    expect(failingSpan).toBeDefined();
    expect(failingSpan?.ok).toBe(false);
    expect(failingSpan?.errorMessage).toBe("Simulated failure");
    
    const rootSpan = spans.find((s) => s.name === "attempt_money_action");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.ok).toBe(false);
  });
});
