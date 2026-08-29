import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import {
  parseRuleAst,
  evaluateRuleAst,
  describeRule,
  computeMarginPercent,
  resolveRewardMultiplier,
  createMerchantAuthoredRule,
  type RuleAst,
} from "@/lib/reward-rules";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * Layer 14-2/14-3: the reward-rule AST. No eval, ever — an LLM only
 * ever drafts a candidate; zod validates it against this exact grammar;
 * deterministic code evaluates it. This file proves both halves: a
 * malformed or out-of-grammar candidate is rejected rather than stored,
 * and a valid rule evaluates exactly as its conditions state.
 */

describe("parseRuleAst — the validation boundary an LLM draft must pass", () => {
  it("accepts a well-formed rule", () => {
    const result = parseRuleAst({ conditions: [{ field: "orderValuePaise", operator: "gt", value: 50_000 }], multiplierPermille: 2000 });
    expect(result.ok).toBe(true);
  });

  it("rejects a field outside the grammar — the model cannot invent a field to reach", () => {
    const result = parseRuleAst({ conditions: [{ field: "buyerEmail", operator: "eq", value: 1 }], multiplierPermille: 1000 });
    expect(result.ok).toBe(false);
  });

  it("rejects an operator outside the grammar", () => {
    const result = parseRuleAst({ conditions: [{ field: "orderValuePaise", operator: "contains", value: 1 }], multiplierPermille: 1000 });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer multiplier", () => {
    const result = parseRuleAst({ conditions: [{ field: "orderValuePaise", operator: "gt", value: 1 }], multiplierPermille: 2000.5 });
    expect(result.ok).toBe(false);
  });

  it("rejects a multiplier outside the sane bound", () => {
    const result = parseRuleAst({ conditions: [{ field: "orderValuePaise", operator: "gt", value: 1 }], multiplierPermille: 999_999 });
    expect(result.ok).toBe(false);
  });

  it("rejects zero conditions — a rule must actually condition on something", () => {
    const result = parseRuleAst({ conditions: [], multiplierPermille: 2000 });
    expect(result.ok).toBe(false);
  });

  it("rejects an attempt to smuggle executable content — an eval/expression string is not a legal value", () => {
    const result = parseRuleAst({ conditions: [{ field: "orderValuePaise", operator: "gt", value: "process.exit()" }], multiplierPermille: 1000 });
    expect(result.ok).toBe(false);
  });

  it("rejects a completely malformed shape", () => {
    expect(parseRuleAst(null).ok).toBe(false);
    expect(parseRuleAst("not an object").ok).toBe(false);
    expect(parseRuleAst({}).ok).toBe(false);
  });
});

describe("evaluateRuleAst — pure, deterministic", () => {
  const rule: RuleAst = {
    conditions: [
      { field: "orderValuePaise", operator: "gt", value: 50_000 },
      { field: "marginPercent", operator: "gte", value: 20 },
    ],
    multiplierPermille: 2000,
  };

  it("matches when every condition holds (flat AND)", () => {
    expect(evaluateRuleAst(rule, { orderValuePaise: 60_000, marginPercent: 25, priorCaptureCount: 0 })).toBe(true);
  });

  it("does not match when one condition fails", () => {
    expect(evaluateRuleAst(rule, { orderValuePaise: 40_000, marginPercent: 25, priorCaptureCount: 0 })).toBe(false);
    expect(evaluateRuleAst(rule, { orderValuePaise: 60_000, marginPercent: 10, priorCaptureCount: 0 })).toBe(false);
  });

  it("a margin-unavailable sentinel never satisfies a margin condition", () => {
    expect(evaluateRuleAst(rule, { orderValuePaise: 60_000, marginPercent: -1_000_000, priorCaptureCount: 0 })).toBe(false);
  });

  it("returning-customer rule via priorCaptureCount", () => {
    const returningRule: RuleAst = { conditions: [{ field: "priorCaptureCount", operator: "gte", value: 1 }], multiplierPermille: 2000 };
    expect(evaluateRuleAst(returningRule, { orderValuePaise: 1, marginPercent: 0, priorCaptureCount: 3 })).toBe(true);
    expect(evaluateRuleAst(returningRule, { orderValuePaise: 1, marginPercent: 0, priorCaptureCount: 0 })).toBe(false);
  });
});

describe("describeRule — compiled English always matches the AST, never hand-authored separately", () => {
  it("renders a readable sentence", () => {
    const ast: RuleAst = { conditions: [{ field: "orderValuePaise", operator: "gt", value: 50_000 }], multiplierPermille: 2000 };
    expect(describeRule(ast)).toBe("When order value is above ₹500.00, apply 2.00x the reward.");
  });
});

describe("computeMarginPercent", () => {
  it("computes integer margin percent, floored", () => {
    expect(computeMarginPercent(1000, 800)).toBe(20);
    expect(computeMarginPercent(1000, 420)).toBe(58);
    expect(computeMarginPercent(999, 333)).toBe(66); // floor(66.6..)
  });

  it("a zero or negative sale price never divides by zero", () => {
    expect(computeMarginPercent(0, 100)).toBe(0);
    expect(computeMarginPercent(-100, 50)).toBe(0);
  });
});

describe("resolveRewardMultiplier — real DB, first match wins", () => {
  let merchantId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    merchantId = undefined;
    await db.delete(schema.rewardRules).where(eq(schema.rewardRules.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("returns 1000 (no change) when no rules exist", async () => {
    const merchant = await createTestMerchant("__reward_rules_test_none__");
    merchantId = merchant.id;
    const result = await resolveRewardMultiplier(merchantId, { orderValuePaise: 100_000, marginPercent: 50, priorCaptureCount: 0 });
    expect(result.multiplierPermille).toBe(1000);
    expect(result.matchedRuleId).toBeNull();
  });

  it("applies the first matching rule in priority order", async () => {
    const merchant = await createTestMerchant("__reward_rules_test_priority__");
    merchantId = merchant.id;

    const low = await createMerchantAuthoredRule(merchantId, { conditions: [{ field: "orderValuePaise", operator: "gte", value: 0 }], multiplierPermille: 1500 }, 10);
    const high = await createMerchantAuthoredRule(merchantId, { conditions: [{ field: "orderValuePaise", operator: "gte", value: 0 }], multiplierPermille: 3000 }, 0);
    expect(low.ok).toBe(true);
    expect(high.ok).toBe(true);

    const result = await resolveRewardMultiplier(merchantId, { orderValuePaise: 100_000, marginPercent: 50, priorCaptureCount: 0 });
    expect(result.multiplierPermille).toBe(3000);
    if (high.ok) expect(result.matchedRuleId).toBe(high.ruleId);
  });

  it("a disabled rule is never evaluated", async () => {
    const merchant = await createTestMerchant("__reward_rules_test_disabled__");
    merchantId = merchant.id;

    const created = await createMerchantAuthoredRule(merchantId, { conditions: [{ field: "orderValuePaise", operator: "gte", value: 0 }], multiplierPermille: 5000 }, 0);
    expect(created.ok).toBe(true);
    if (created.ok) {
      await db.update(schema.rewardRules).set({ enabled: false }).where(eq(schema.rewardRules.id, created.ruleId));
    }

    const result = await resolveRewardMultiplier(merchantId, { orderValuePaise: 100_000, marginPercent: 50, priorCaptureCount: 0 });
    expect(result.multiplierPermille).toBe(1000);
  });

  it("an unapproved (llm_drafted, not yet approved) rule is never evaluated", async () => {
    const merchant = await createTestMerchant("__reward_rules_test_unapproved__");
    merchantId = merchant.id;

    await db.insert(schema.rewardRules).values({
      merchantId,
      description: "test unapproved rule",
      astJson: { conditions: [{ field: "orderValuePaise", operator: "gte", value: 0 }], multiplierPermille: 9000 },
      source: "llm_drafted",
      approved: false,
      enabled: true,
      priority: 0,
    });

    const result = await resolveRewardMultiplier(merchantId, { orderValuePaise: 100_000, marginPercent: 50, priorCaptureCount: 0 });
    expect(result.multiplierPermille).toBe(1000);
  });
});
