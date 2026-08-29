import { eq, and, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { complete, type CompletionInput, type CompletionResult, type LlmProvider } from "@/lib/llm";
import { computeCallCostPaise, isKnownModel, providerForModel } from "@/lib/model-pricing";
import { drawMerchantAiBudget } from "@/lib/treasury";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 14-4: per-use-case AI model budgets and routing, funded from the
 * treasury's merchant_ai_budget bucket. Extends llm.ts's existing
 * groqModelOverride rather than replacing the shared wrapper — this
 * module decides WHICH model id to pass, llm.ts still owns provider
 * selection, fallback, timeout, and logging which provider actually
 * served the call (CLAUDE.md's "one shared wrapper module" rule).
 *
 * The router itself never decides an amount or a bound — it reads a
 * merchant-set budgetPaise, computes real spend as SUM(model_call_costs),
 * and takes the deterministic branch: enough budget left -> serve the
 * requested (premium) model; not enough -> degrade to the cheapest known
 * model; no budget row at all -> degrade to the cheapest known model
 * (an unconfigured use case is treated as budget-zero, not
 * unboundedly-fundable). Never silently overspends past the allocation.
 */

export type ModelUseCase = (typeof schema.modelUseCaseEnum.enumValues)[number];

// The model each use case would use if cost were no object — what
// "premium" means for that use case's routing-savings comparison.
// Merchant-set in a real system; fixed here since this project has one
// premium tier per provider tier, not a per-merchant catalogue (same
// scoping honesty as ai-credits.ts's fixed tier set).
const PREMIUM_MODEL_ID = "openai/gpt-oss-120b";
const CHEAPEST_MODEL_ID = "openai/gpt-oss-20b";

/**
 * Layer 16: which model id a merchant's explicit `preferredProvider`
 * resolves to as that use case's "premium" tier. Only Groq's own two
 * models are reachable without an explicit preference (unchanged
 * default). risk.ts deliberately never sets a preference and stays on
 * Groq — the only provider this project has real operating history for
 * on the money path, and the one whose deterministicFallback() prefix
 * explainability.ts depends on (see plans/layer-16, L16-3).
 */
const PREFERRED_PROVIDER_MODEL: Record<string, string> = {
  nvidia: "nvidia/nemotron-3-nano-30b-a3b",
  openrouter: "z-ai/glm-4.6",
  zai: "glm-4.6",
};

export interface RoutedCompletionResult extends CompletionResult {
  costPaise: number;
  premiumCostPaise: number;
  degraded: boolean;
}

async function getBudgetRow(merchantId: string, useCase: ModelUseCase) {
  const [row] = await db
    .select()
    .from(schema.modelBudgets)
    .where(and(eq(schema.modelBudgets.merchantId, merchantId), eq(schema.modelBudgets.useCase, useCase)));
  return row ?? null;
}

/** Real spend so far this period — SUM(costPaise), never a mutable counter. */
export async function getUseCaseSpendPaise(merchantId: string, useCase: ModelUseCase, periodStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.modelCallCosts.costPaise}), 0)` })
    .from(schema.modelCallCosts)
    .where(and(eq(schema.modelCallCosts.merchantId, merchantId), eq(schema.modelCallCosts.useCase, useCase), gte(schema.modelCallCosts.createdAt, periodStart)));
  return Number(row?.total ?? 0);
}

export async function setModelBudget(merchantId: string, useCase: ModelUseCase, budgetPaise: number): Promise<void> {
  if (!Number.isInteger(budgetPaise) || budgetPaise < 0) {
    throw new Error(`setModelBudget: budgetPaise must be a non-negative integer, got ${budgetPaise}`);
  }
  // periodStart is set from the DB's own clock (sql`now()`) ONLY on
  // first creation, and deliberately left untouched by
  // onConflictDoUpdate's set clause on every later edit. Two real bugs
  // this avoids: (1) using the app server's new Date() here, compared
  // against model_call_costs.createdAt (DB-stamped via defaultNow()),
  // risks any app/DB clock skew silently excluding real spend from the
  // sum; (2) resetting periodStart on every budget edit would zero out
  // real prior spend the moment a merchant adjusts their own budget —
  // a use case's spend history must survive a budget change, only an
  // explicit reset (not built here) should ever restart the period. See
  // FAILURES.md.
  await db
    .insert(schema.modelBudgets)
    .values({ merchantId, useCase, budgetPaise, periodStart: sql`now()` })
    .onConflictDoUpdate({
      target: [schema.modelBudgets.merchantId, schema.modelBudgets.useCase],
      set: { budgetPaise, updatedAt: sql`now()` },
    });
}

const ROUTABLE_PROVIDERS = new Set(Object.keys(PREFERRED_PROVIDER_MODEL));

/**
 * Layer 16: sets which non-default provider a use case should route to
 * when its budget isn't exhausted. `null` clears the preference back to
 * the router's built-in default (Groq's premium tier). Requires a
 * budget row to already exist — a use case with no budget row is
 * already treated as budget-zero and would degrade regardless of any
 * provider preference, so setting one first is a merchant no-op.
 */
export async function setUseCaseProvider(merchantId: string, useCase: ModelUseCase, provider: string | null): Promise<void> {
  if (provider !== null && !ROUTABLE_PROVIDERS.has(provider)) {
    throw new Error(`setUseCaseProvider: "${provider}" is not a routable provider`);
  }
  const row = await getBudgetRow(merchantId, useCase);
  if (!row) {
    throw new Error(`setUseCaseProvider: ${useCase} has no budget configured yet — set a budget first`);
  }
  await db
    .update(schema.modelBudgets)
    .set({ preferredProvider: provider, updatedAt: sql`now()` })
    .where(and(eq(schema.modelBudgets.merchantId, merchantId), eq(schema.modelBudgets.useCase, useCase)));
}

export interface UseCaseBudgetStatus {
  useCase: ModelUseCase;
  budgetPaise: number;
  spentPaise: number;
  remainingPaise: number;
  configured: boolean;
  preferredProvider: string | null;
}

export async function getUseCaseBudgetStatus(merchantId: string, useCase: ModelUseCase): Promise<UseCaseBudgetStatus> {
  const row = await getBudgetRow(merchantId, useCase);
  if (!row) {
    return { useCase, budgetPaise: 0, spentPaise: 0, remainingPaise: 0, configured: false, preferredProvider: null };
  }
  const spentPaise = await getUseCaseSpendPaise(merchantId, useCase, row.periodStart);
  return {
    useCase,
    budgetPaise: row.budgetPaise,
    spentPaise,
    remainingPaise: Math.max(row.budgetPaise - spentPaise, 0),
    configured: true,
    preferredProvider: row.preferredProvider,
  };
}

/**
 * Routes a completion for a merchant AI use case, degrading to the
 * cheapest tier deterministically if the use case's budget is
 * exhausted — never silently overspending past its allocation. The
 * degrade check happens BEFORE the call (never after — an already-
 * incurred cost can't be un-spent), using the real remaining budget as
 * of this call, not an estimate.
 *
 * Records the real cost (model_call_costs) and draws it from the
 * treasury's merchant_ai_budget bucket AFTER the call succeeds, since
 * only a real, completed call has a real cost — a failed call is never
 * charged.
 */
export async function routeCompletion(merchantId: string, useCase: ModelUseCase, input: CompletionInput): Promise<RoutedCompletionResult> {
  const budget = await getUseCaseBudgetStatus(merchantId, useCase);
  const wouldDegrade = !budget.configured || budget.remainingPaise <= 0;

  // A preferred provider only changes which model is requested when
  // there's budget to spend on it — an exhausted or unconfigured use
  // case always degrades to the cheapest known Groq tier regardless of
  // provider preference, never to "the cheapest tier on the preferred
  // provider," since that's not necessarily cheap at all.
  const preferredModelId = budget.preferredProvider ? PREFERRED_PROVIDER_MODEL[budget.preferredProvider] : undefined;
  const requestedModelId =
    preferredModelId ?? (input.groqModelOverride && isKnownModel(input.groqModelOverride) ? input.groqModelOverride : PREMIUM_MODEL_ID);
  const modelIdToUse = wouldDegrade ? CHEAPEST_MODEL_ID : requestedModelId;
  const providerToUse = wouldDegrade ? undefined : (providerForModel(modelIdToUse) as LlmProvider | undefined);

  const result = await complete({
    ...input,
    groqModelOverride: modelIdToUse,
    provider: providerToUse === "nvidia" || providerToUse === "openrouter" || providerToUse === "zai" ? providerToUse : undefined,
  });

  const usage = result.usage ?? { promptTokens: 0, completionTokens: 0 };
  const costPaise = isKnownModel(result.modelId) ? computeCallCostPaise(result.modelId, usage) : 0;
  const premiumCostPaise = isKnownModel(PREMIUM_MODEL_ID) ? computeCallCostPaise(PREMIUM_MODEL_ID, usage) : costPaise;

  await db.insert(schema.modelCallCosts).values({
    merchantId,
    useCase,
    modelId: result.modelId,
    provider: result.provider,
    costPaise,
    premiumCostPaise,
    degraded: wouldDegrade,
  });

  if (costPaise > 0) {
    try {
      await drawMerchantAiBudget(
        merchantId,
        costPaise,
        `Model call for ${useCase}: ${result.modelId} via ${result.provider}, ${usage.promptTokens}+${usage.completionTokens} tokens${wouldDegrade ? " (degraded — budget exhausted)" : ""}`,
      );
    } catch (err) {
      // The treasury draw is bookkeeping for money already spent, never
      // a gate on whether the call happened — a failure here must not
      // make a real, already-served response disappear. Logged loudly,
      // never silently swallowed.
      console.error("[model-router] treasury draw failed after a real model call:", err);
    }
  }

  if (wouldDegrade) {
    await logAuditEntry({
      merchantId,
      actor: "system",
      event: "model_budget_degraded",
      decision: "n/a",
      reason: `${useCase}'s AI model budget is ${budget.configured ? "exhausted" : "not configured"} (spent ₹${(budget.spentPaise / 100).toFixed(2)} of ₹${(budget.budgetPaise / 100).toFixed(2)}) — degraded to ${CHEAPEST_MODEL_ID} instead of ${requestedModelId}.`,
      boundApplied: `model_budget:${merchantId}:${useCase}`,
    });
  }

  return { ...result, costPaise, premiumCostPaise, degraded: wouldDegrade };
}

/** Real savings this period: what routing actually cost vs. what the premium tier would have cost for the same calls — never an estimate. */
export async function getRoutingSavings(merchantId: string, useCase?: ModelUseCase): Promise<{ actualCostPaise: number; premiumCostPaise: number; savedPaise: number; callCount: number }> {
  const conditions = useCase ? and(eq(schema.modelCallCosts.merchantId, merchantId), eq(schema.modelCallCosts.useCase, useCase)) : eq(schema.modelCallCosts.merchantId, merchantId);
  const [row] = await db
    .select({
      actualCostPaise: sql<string>`coalesce(sum(${schema.modelCallCosts.costPaise}), 0)`,
      premiumCostPaise: sql<string>`coalesce(sum(${schema.modelCallCosts.premiumCostPaise}), 0)`,
      callCount: sql<string>`count(*)`,
    })
    .from(schema.modelCallCosts)
    .where(conditions);

  const actualCostPaise = Number(row?.actualCostPaise ?? 0);
  const premiumCostPaise = Number(row?.premiumCostPaise ?? 0);
  return { actualCostPaise, premiumCostPaise, savedPaise: premiumCostPaise - actualCostPaise, callCount: Number(row?.callCount ?? 0) };
}
