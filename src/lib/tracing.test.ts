import { describe, it, expect, vi } from "vitest";
import { withMoneyPathSpan, withSpan, getSpansForMoneyAction, MoneyPathCaptureProcessor } from "./tracing";
import { trace, context, SpanProcessor } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

// Set up the tracer provider to actually process spans in the test
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new MoneyPathCaptureProcessor() as any);
provider.register();

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
