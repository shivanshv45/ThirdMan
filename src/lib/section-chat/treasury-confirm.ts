import { setTreasurySettings } from "@/lib/treasury";
import { createMerchantAuthoredRule, type RuleAst } from "@/lib/reward-rules";
import { setModelBudget } from "@/lib/model-router";
import { treasuryProposalSchema, type TreasuryProposal } from "./treasury-schema";

/**
 * The Treasury section chat bar's write-facing half. Calls the exact
 * same functions actions.ts's saveTreasurySettings, createRewardRule,
 * and saveModelBudget Server Actions call. No import of the LLM
 * wrapper or treasury-draft.ts, see section-chat/treasury.isolation.test.ts.
 */

export async function confirmTreasuryAction(
  merchantId: string,
  proposal: TreasuryProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = treasuryProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "set_treasury_settings") {
      const { allocationPercent, buyerPercent, merchantPercent, reservePercent, enabled } = parsed.data;
      const result = await setTreasurySettings(merchantId, {
        allocationBasisPoints: Math.round(allocationPercent * 100),
        buyerShareBps: Math.round(buyerPercent * 100),
        merchantShareBps: Math.round(merchantPercent * 100),
        reserveShareBps: Math.round(reservePercent * 100),
        enabled,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true };
    }

    if (parsed.data.kind === "create_reward_rule") {
      const { field, operator, value, multiplierX, priority } = parsed.data;
      const rawValue = field === "orderValuePaise" ? Math.round(value * 100) : value;
      const ast: RuleAst = {
        conditions: [{ field, operator, value: rawValue }],
        multiplierPermille: Math.round(multiplierX * 1000),
      };
      const result = await createMerchantAuthoredRule(merchantId, ast, priority);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true };
    }

    if (parsed.data.kind === "set_model_budget") {
      const { useCase, budgetRupees } = parsed.data;
      await setModelBudget(merchantId, useCase, Math.round(budgetRupees * 100));
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not run that action." };
  }
}
