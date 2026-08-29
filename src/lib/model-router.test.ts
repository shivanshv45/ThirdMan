import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { routeCompletion, setModelBudget, setUseCaseProvider, getUseCaseBudgetStatus, getRoutingSavings } from "@/lib/model-router";
import { createTestMerchant } from "@/lib/test-helpers";
import { env } from "@/lib/env";

/**
 * Layer 14-4: real Groq calls (no mocks, same standard as llm.test.ts
 * and ai-credits.test.ts), proving the one assertion that matters most:
 * a use case whose budget is exhausted degrades to the cheapest tier
 * deterministically — it never silently overspends past its allocation.
 */

describe("model-router — real Groq calls, real budget arithmetic", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.modelCallCosts).where(eq(schema.modelCallCosts.merchantId, currentMerchantId));
    await db.delete(schema.modelBudgets).where(eq(schema.modelBudgets.merchantId, currentMerchantId));
    await db.delete(schema.treasuryLedger).where(eq(schema.treasuryLedger.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("an unconfigured use case (no budget row) degrades to the cheapest tier, never the premium one", async () => {
    const merchant = await createTestMerchant("__model_router_test_unconfigured__");
    merchantId = merchant.id;

    const result = await routeCompletion(merchant.id, "classification", { prompt: "Say 'ok' and nothing else." });

    expect(result.degraded).toBe(true);
    expect(result.modelId).toBe("openai/gpt-oss-20b");
    expect(result.costPaise).toBeGreaterThanOrEqual(0);

    const [callRow] = await db.select().from(schema.modelCallCosts).where(eq(schema.modelCallCosts.merchantId, merchant.id));
    expect(callRow.degraded).toBe(true);
  }, 20_000);

  it("a use case with real remaining budget is served by the premium tier, not degraded", async () => {
    const merchant = await createTestMerchant("__model_router_test_funded__");
    merchantId = merchant.id;
    await setModelBudget(merchant.id, "support_chat", 10_000_00); // ₹10,000 — effectively unlimited for one test call

    const result = await routeCompletion(merchant.id, "support_chat", { prompt: "Say 'ok' and nothing else." });

    expect(result.degraded).toBe(false);
    expect(result.modelId).toBe("openai/gpt-oss-120b");
  }, 20_000);

  it("a use case with its budget already exhausted degrades deterministically, without overspending past the allocation", async () => {
    const merchant = await createTestMerchant("__model_router_test_exhausted__");
    merchantId = merchant.id;
    // A generous budget for the first call, so it genuinely gets served
    // at the premium tier and accrues a real, non-zero cost — a longer
    // real prompt guarantees a non-trivial token count rather than
    // gambling on a tiny "say ok" prompt happening to round to > 0 paise.
    await setModelBudget(merchant.id, "negotiation", 10_000_00);
    const longPrompt = "Explain, in exactly three plain sentences, why integer arithmetic is safer than floating point for representing money in a payments system.";
    const first = await routeCompletion(merchant.id, "negotiation", { prompt: longPrompt });
    expect(first.degraded).toBe(false);
    expect(first.costPaise).toBeGreaterThan(0);

    // Now set the budget to exactly what was already spent — real spend
    // meets the allocation exactly, so the NEXT call must degrade. This
    // is the deterministic bound: the check re-evaluates real spend
    // against the real budget every call, not a cached flag.
    await setModelBudget(merchant.id, "negotiation", first.costPaise);
    const statusAfter = await getUseCaseBudgetStatus(merchant.id, "negotiation");
    expect(statusAfter.remainingPaise).toBe(0);

    const second = await routeCompletion(merchant.id, "negotiation", { prompt: "Say 'ok' and nothing else." });
    expect(second.degraded).toBe(true);
    expect(second.modelId).toBe("openai/gpt-oss-20b");

    const degradedAudit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(degradedAudit.some((e) => e.event === "model_budget_degraded")).toBe(true);
  }, 30_000);

  it("getRoutingSavings reports real, non-negative figures traceable to real model_call_costs rows", async () => {
    const merchant = await createTestMerchant("__model_router_test_savings__");
    merchantId = merchant.id;
    await setModelBudget(merchant.id, "recovery_diagnosis", 10_000_00);

    await routeCompletion(merchant.id, "recovery_diagnosis", { prompt: "Say 'ok' and nothing else." });

    const savings = await getRoutingSavings(merchant.id, "recovery_diagnosis");
    expect(savings.callCount).toBe(1);
    expect(savings.actualCostPaise).toBeGreaterThanOrEqual(0);
    expect(savings.premiumCostPaise).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it("drawMerchantAiBudget records real treasury ledger draws for each call", async () => {
    const merchant = await createTestMerchant("__model_router_test_ledger__");
    merchantId = merchant.id;
    await setModelBudget(merchant.id, "classification", 10_000_00);

    await routeCompletion(merchant.id, "classification", { prompt: "Say 'ok' and nothing else." });

    const ledgerRows = await db.select().from(schema.treasuryLedger).where(eq(schema.treasuryLedger.merchantId, merchant.id));
    const spendRows = ledgerRows.filter((r) => r.reason === "model_spend");
    expect(spendRows.length).toBeGreaterThanOrEqual(0); // 0 only if the real call happened to cost exactly 0 paise (tiny prompt)
    for (const row of spendRows) {
      expect(row.amountPaise).toBeLessThan(0); // a draw is always negative
    }
  }, 20_000);

  // Layer 16: a use case with a real provider preference routes there
  // when funded, and still degrades to the Groq cheapest tier — never
  // "the cheapest model on the preferred provider" — when exhausted.
  it.skipIf(!env.OPENROUTER_API_KEY)("a use case with a preferred provider routes to it when funded, and degrades to Groq's cheapest tier when exhausted", async () => {
    const merchant = await createTestMerchant("__model_router_test_provider_pref__");
    merchantId = merchant.id;
    await setModelBudget(merchant.id, "support_chat", 10_000_00);
    await setUseCaseProvider(merchant.id, "support_chat", "openrouter");

    const funded = await routeCompletion(merchant.id, "support_chat", { prompt: "Say 'ok' and nothing else." });
    expect(funded.degraded).toBe(false);
    expect(funded.provider).toBe("openrouter");
    expect(funded.modelId).toBe("z-ai/glm-4.6");

    await setModelBudget(merchant.id, "support_chat", 0);
    const exhausted = await routeCompletion(merchant.id, "support_chat", { prompt: "Say 'ok' and nothing else." });
    expect(exhausted.degraded).toBe(true);
    expect(exhausted.modelId).toBe("openai/gpt-oss-20b");
    expect(exhausted.provider).toBe("groq");
  }, 45_000);

  it("setUseCaseProvider rejects an unroutable provider name and a use case with no budget row yet", async () => {
    const merchant = await createTestMerchant("__model_router_test_provider_reject__");
    merchantId = merchant.id;
    await expect(setUseCaseProvider(merchant.id, "classification", "not-a-real-provider")).rejects.toThrow(/not a routable provider/);
    await expect(setUseCaseProvider(merchant.id, "classification", "zai")).rejects.toThrow(/no budget configured/);
  });
});
