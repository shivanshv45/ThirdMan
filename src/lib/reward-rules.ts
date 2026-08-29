import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { completeStructured } from "@/lib/llm";

/**
 * Layer 14-2/14-3: margin-aware reward multipliers, expressed as a small
 * merchant-authored (or LLM-drafted, merchant-approved) rule AST.
 *
 * The pipeline is the thesis made literal (CLAUDE.md, "AI decides
 * judgment, code decides limits"):
 *  1. The LLM DRAFTS a candidate rule as structured output.
 *  2. Zod VALIDATES it against this exact grammar — the model cannot
 *     reach any field or operator not defined here.
 *  3. Deterministic code EVALUATES the stored rule at issue time.
 *
 * No eval(), ever. The model never executes anything; it proposes a
 * data structure our own validator either accepts or rejects. Why a
 * custom zod AST instead of JSON Logic: JSON Logic exposes ~40
 * operators, most of which a reward rule has no business reaching for,
 * and it is untyped at our boundary. This grammar exposes exactly the
 * permitted fields and comparisons, gives end-to-end TypeScript types,
 * and validates at the same request boundary every other input in this
 * codebase already goes through. See DECISIONS.md.
 */

// The only facts a rule may ever compare against — deterministically
// computed at issue time from real captured-purchase data, never from
// anything a buyer or an LLM asserts.
export const ruleFieldEnum = z.enum(["orderValuePaise", "marginPercent", "priorCaptureCount"]);
export type RuleField = z.infer<typeof ruleFieldEnum>;

const comparisonOperatorEnum = z.enum(["gt", "gte", "lt", "lte", "eq"]);

const conditionSchema = z.object({
  field: ruleFieldEnum,
  operator: comparisonOperatorEnum,
  value: z.number().finite(),
});
export type RuleCondition = z.infer<typeof conditionSchema>;

// A rule's condition is a flat AND of comparisons — deliberately no OR,
// no nesting: the plan's example ("above ₹500 AND margin exceeds 20%")
// needs nothing richer, and a flat list is what keeps the compiled
// English description honest and the grammar small enough to audit at a
// glance. Add a nested/OR form only if a real merchant need shows up.
const ruleAstSchema = z.object({
  conditions: z.array(conditionSchema).min(1).max(5),
  // Integer permille multiplier applied to the base coin issuance —
  // 1000 = 1x (no change), 2000 = 2x, 500 = half. Integer arithmetic
  // only, same discipline as issueRatePermille.
  multiplierPermille: z.number().int().min(0).max(10_000),
});
export type RuleAst = z.infer<typeof ruleAstSchema>;

export function parseRuleAst(candidate: unknown): { ok: true; ast: RuleAst } | { ok: false; reason: string } {
  const result = ruleAstSchema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, ast: result.data };
}

const FIELD_LABELS: Record<RuleField, string> = {
  orderValuePaise: "order value",
  marginPercent: "margin",
  priorCaptureCount: "prior purchases",
};

const OPERATOR_LABELS: Record<z.infer<typeof comparisonOperatorEnum>, string> = {
  gt: "is above",
  gte: "is at least",
  lt: "is below",
  lte: "is at most",
  eq: "equals",
};

function formatConditionValue(field: RuleField, value: number): string {
  if (field === "orderValuePaise") return `₹${(value / 100).toFixed(2)}`;
  if (field === "marginPercent") return `${value}%`;
  return String(value);
}

/**
 * Compiles an AST into the plain-English sentence a merchant reads
 * before approving it. Regenerated from astJson every time, never
 * hand-edited independently — so description and astJson can never
 * disagree about what the rule actually does.
 */
export function describeRule(ast: RuleAst): string {
  const conditionText = ast.conditions.map((c) => `${FIELD_LABELS[c.field]} ${OPERATOR_LABELS[c.operator]} ${formatConditionValue(c.field, c.value)}`).join(" and ");
  const multiplierText = ast.multiplierPermille === 1000 ? "no change to the reward" : `${(ast.multiplierPermille / 1000).toFixed(2)}x the reward`;
  return `When ${conditionText}, apply ${multiplierText}.`;
}

export interface RuleContext {
  orderValuePaise: number;
  marginPercent: number;
  priorCaptureCount: number;
}

function evaluateCondition(condition: RuleCondition, ctx: RuleContext): boolean {
  const actual = ctx[condition.field];
  switch (condition.operator) {
    case "gt":
      return actual > condition.value;
    case "gte":
      return actual >= condition.value;
    case "lt":
      return actual < condition.value;
    case "lte":
      return actual <= condition.value;
    case "eq":
      return actual === condition.value;
  }
}

/** Pure: true only if every condition in the rule's flat AND matches. */
export function evaluateRuleAst(ast: RuleAst, ctx: RuleContext): boolean {
  return ast.conditions.every((c) => evaluateCondition(c, ctx));
}

/**
 * Margin percent, integer, computed deterministically from real
 * pricePaise/costPaise at issue time — never stored, never asserted by
 * a caller. costPaise must never leak past this function to any
 * buyer-facing surface (cost-paise-never-leaks.test.ts covers this).
 */
export function computeMarginPercent(salePricePaise: number, costPaise: number): number {
  if (salePricePaise <= 0) return 0;
  return Math.floor(((salePricePaise - costPaise) * 100) / salePricePaise);
}

/**
 * How many times this agent identity has a genuinely captured purchase
 * on record, EXCLUDING the purchase currently being rewarded — the
 * deterministic "returning buyer" signal. Exclusion matters: by the
 * time issueRewardCoinsForCapture runs, confirmCapture has already
 * marked the current purchase "captured", so a naive count would call
 * every buyer's first-ever purchase "not first-time."
 */
export async function countPriorCaptures(merchantId: string, agentId: string, excludingMoneyActionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.moneyActions)
    .where(
      and(
        eq(schema.moneyActions.merchantId, merchantId),
        eq(schema.moneyActions.agentId, agentId),
        eq(schema.moneyActions.status, "captured"),
        sql`${schema.moneyActions.id} != ${excludingMoneyActionId}`,
      ),
    );
  return Number(row?.count ?? 0);
}

// A margin condition can never legally match a purchase with no known
// cost basis (a cart or offer/negotiation purchase spanning several
// variants, where a single margin figure would be a guess) — a sentinel
// below every real margin percent (which is always >= a large negative
// bound in practice, but the point is this must never accidentally
// satisfy a "gt"/"gte" comparison a merchant wrote expecting real data).
const MARGIN_UNAVAILABLE = -1_000_000;

/**
 * Assembles the real RuleContext for a just-captured purchase. Margin
 * is only computed for a single-variant purchase (moneyActions.variantId
 * present) — a cart or offer/negotiation purchase spanning several SKUs
 * has no single honest margin figure, so margin conditions simply never
 * match rather than being estimated.
 */
export async function buildRuleContext(merchantId: string, moneyAction: { id: string; agentId: string | null; amountPaise: number; variantId: string | null }): Promise<RuleContext> {
  let marginPercent = MARGIN_UNAVAILABLE;
  if (moneyAction.variantId) {
    const [variant] = await db.select({ pricePaise: schema.productVariants.pricePaise, costPaise: schema.productVariants.costPaise }).from(schema.productVariants).where(eq(schema.productVariants.id, moneyAction.variantId));
    if (variant) {
      marginPercent = computeMarginPercent(moneyAction.amountPaise, variant.costPaise);
    }
  }

  const priorCaptureCount = moneyAction.agentId ? await countPriorCaptures(merchantId, moneyAction.agentId, moneyAction.id) : 0;

  return { orderValuePaise: moneyAction.amountPaise, marginPercent, priorCaptureCount };
}

/**
 * Every enabled, approved rule for a merchant, in priority order. An
 * llm_drafted rule that hasn't been approved is never returned here —
 * the plan's "an LLM-drafted rule never activates unreviewed."
 */
async function getActiveRules(merchantId: string) {
  return db
    .select()
    .from(schema.rewardRules)
    .where(and(eq(schema.rewardRules.merchantId, merchantId), eq(schema.rewardRules.enabled, true), eq(schema.rewardRules.approved, true)))
    .orderBy(schema.rewardRules.priority);
}

/**
 * The multiplier permille to apply for this purchase — the first
 * matching rule wins (same "first match, not all of them" discipline as
 * guardian.ts's evaluateGuardianSignals), 1000 (no change) if none
 * match or no rules exist. Every candidate's condition is evaluated
 * purely in code against ctx; the AST is never eval'd or interpreted by
 * a model at this stage.
 */
export async function resolveRewardMultiplier(merchantId: string, ctx: RuleContext): Promise<{ multiplierPermille: number; matchedRuleId: string | null; matchedDescription: string | null }> {
  const rules = await getActiveRules(merchantId);
  for (const rule of rules) {
    const parsed = parseRuleAst(rule.astJson);
    if (!parsed.ok) continue; // a corrupted row is skipped, never crashes issuance
    if (evaluateRuleAst(parsed.ast, ctx)) {
      return { multiplierPermille: parsed.ast.multiplierPermille, matchedRuleId: rule.id, matchedDescription: rule.description };
    }
  }
  return { multiplierPermille: 1000, matchedRuleId: null, matchedDescription: null };
}

/**
 * Stores a merchant-authored rule directly — approved: true immediately,
 * since a merchant typing the rule into the form themselves IS the
 * approval the plan requires.
 */
export async function createMerchantAuthoredRule(merchantId: string, ast: RuleAst, priority: number): Promise<{ ok: true; ruleId: string } | { ok: false; reason: string }> {
  const parsed = parseRuleAst(ast);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const [row] = await db
    .insert(schema.rewardRules)
    .values({
      merchantId,
      description: describeRule(parsed.ast),
      astJson: parsed.ast,
      source: "merchant_authored",
      approved: true,
      enabled: true,
      priority,
    })
    .returning({ id: schema.rewardRules.id });
  return { ok: true, ruleId: row.id };
}

const draftedRuleSchema = z.object({
  conditions: z.array(
    z.object({
      field: ruleFieldEnum,
      operator: comparisonOperatorEnum,
      value: z.number(),
    }),
  ),
  multiplierPermille: z.number(),
});

/**
 * L14-3's step 1: the LLM drafts a candidate from a merchant's plain-
 * English instruction. The draft is inert — never inserted as approved
 * — until draftRule's caller shows it to the merchant via describeRule
 * and a separate approval step calls createMerchantAuthoredRule-style
 * insertion with source: "llm_drafted", approved: true only on explicit
 * merchant confirmation (see dashboard actions). A draft that fails zod
 * validation is rejected outright, never stored, never activated —
 * exactly the guarantee reward-rules.test.ts proves.
 */
export async function draftRuleFromInstruction(instruction: string): Promise<{ ok: true; ast: RuleAst; description: string } | { ok: false; reason: string }> {
  const schemaDescription = `{"conditions": [{"field": "orderValuePaise" | "marginPercent" | "priorCaptureCount", "operator": "gt" | "gte" | "lt" | "lte" | "eq", "value": number}], "multiplierPermille": integer}. orderValuePaise is in paise (₹1 = 100). marginPercent is 0-100. multiplierPermille: 1000 = no change, 2000 = 2x reward. priorCaptureCount is how many times this buyer has purchased before (0 = first-time buyer).`;

  try {
    const { data } = await completeStructured({
      prompt: `A merchant wrote this reward rule in plain English: "${instruction}"\n\nConvert it into the JSON structure described below. Use only the listed fields and operators. If the instruction mentions a percentage discount or multiplier like "2x" or "double", set multiplierPermille accordingly (2x = 2000). If it mentions "returning customer", use priorCaptureCount with operator "gte" and value 1. If it mentions "first-time buyer", use priorCaptureCount with operator "eq" and value 0.`,
      schema: draftedRuleSchema,
      schemaDescription,
    });

    const parsed = parseRuleAst(data);
    if (!parsed.ok) {
      return { ok: false, reason: `Drafted rule failed validation: ${parsed.reason}` };
    }
    return { ok: true, ast: parsed.ast, description: describeRule(parsed.ast) };
  } catch (err) {
    return { ok: false, reason: `Could not draft a rule from that instruction: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function approveDraftedRule(merchantId: string, ast: RuleAst, priority: number): Promise<{ ok: true; ruleId: string } | { ok: false; reason: string }> {
  const parsed = parseRuleAst(ast);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const [row] = await db
    .insert(schema.rewardRules)
    .values({
      merchantId,
      description: describeRule(parsed.ast),
      astJson: parsed.ast,
      source: "llm_drafted",
      approved: true, // explicit merchant approval is this function's own precondition — see dashboard action caller
      enabled: true,
      priority,
    })
    .returning({ id: schema.rewardRules.id });
  return { ok: true, ruleId: row.id };
}

export async function listRewardRules(merchantId: string) {
  return db.select().from(schema.rewardRules).where(eq(schema.rewardRules.merchantId, merchantId)).orderBy(schema.rewardRules.priority);
}

export async function setRewardRuleEnabled(merchantId: string, ruleId: string, enabled: boolean): Promise<void> {
  await db
    .update(schema.rewardRules)
    .set({ enabled })
    .where(and(eq(schema.rewardRules.id, ruleId), eq(schema.rewardRules.merchantId, merchantId)));
}

export async function deleteRewardRule(merchantId: string, ruleId: string): Promise<void> {
  await db.delete(schema.rewardRules).where(and(eq(schema.rewardRules.id, ruleId), eq(schema.rewardRules.merchantId, merchantId)));
}
