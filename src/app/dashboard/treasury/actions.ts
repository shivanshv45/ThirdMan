"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSessionMerchant } from "@/lib/auth";
import { setTreasurySettings } from "@/lib/treasury";
import { createMerchantAuthoredRule, setRewardRuleEnabled, deleteRewardRule, draftRuleFromInstruction, approveDraftedRule, type RuleAst } from "@/lib/reward-rules";
import { setModelBudget } from "@/lib/model-router";
import { draftTreasuryAction, type ChatTurn } from "@/lib/section-chat/treasury-draft";
import { confirmTreasuryAction } from "@/lib/section-chat/treasury-confirm";
import type { TreasuryProposal } from "@/lib/section-chat/treasury-schema";

export async function draftTreasuryChatAction(history: ChatTurn[]) {
  const merchant = await requireSessionMerchant();
  return draftTreasuryAction(merchant.id, history);
}

export async function confirmTreasuryChatAction(proposal: TreasuryProposal) {
  const merchant = await requireSessionMerchant();
  const result = await confirmTreasuryAction(merchant.id, proposal);
  if (result.ok) revalidatePath("/dashboard/treasury");
  return result;
}

function fail(message: string): never {
  redirect(`/dashboard/treasury?error=${encodeURIComponent(message)}`);
}

export async function saveTreasurySettings(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const allocationPercent = Number(formData.get("allocationPercent"));
  const buyerPercent = Number(formData.get("buyerPercent"));
  const merchantPercent = Number(formData.get("merchantPercent"));
  const reservePercent = Number(formData.get("reservePercent"));
  const enabled = formData.get("enabled") === "on";

  if (!Number.isFinite(allocationPercent) || allocationPercent < 0 || allocationPercent > 100) {
    fail("Allocation percent must be between 0 and 100.");
  }

  const result = await setTreasurySettings(merchant.id, {
    allocationBasisPoints: Math.round(allocationPercent * 100),
    buyerShareBps: Math.round(buyerPercent * 100),
    merchantShareBps: Math.round(merchantPercent * 100),
    reserveShareBps: Math.round(reservePercent * 100),
    enabled,
  });

  if (!result.ok) fail(result.reason);

  revalidatePath("/dashboard/treasury");
}

export async function createRewardRule(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const field = String(formData.get("field") ?? "");
  const operator = String(formData.get("operator") ?? "");
  const value = Number(formData.get("value"));
  const multiplierX = Number(formData.get("multiplierX"));
  const priority = Number(formData.get("priority") ?? 0);

  if (!["orderValuePaise", "marginPercent", "priorCaptureCount"].includes(field)) fail("Unknown field.");
  if (!["gt", "gte", "lt", "lte", "eq"].includes(operator)) fail("Unknown operator.");
  if (!Number.isFinite(value)) fail("Value must be a number.");
  if (!Number.isFinite(multiplierX) || multiplierX < 0) fail("Multiplier must be a non-negative number.");

  const rawValue = field === "orderValuePaise" ? Math.round(value * 100) : value;

  const ast: RuleAst = {
    conditions: [{ field: field as RuleAst["conditions"][number]["field"], operator: operator as RuleAst["conditions"][number]["operator"], value: rawValue }],
    multiplierPermille: Math.round(multiplierX * 1000),
  };

  const result = await createMerchantAuthoredRule(merchant.id, ast, Number.isFinite(priority) ? priority : 0);
  if (!result.ok) fail(result.reason);

  revalidatePath("/dashboard/treasury");
}

export async function toggleRewardRule(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const ruleId = String(formData.get("ruleId") ?? "");
  const enabled = formData.get("enabled") === "true";
  await setRewardRuleEnabled(merchant.id, ruleId, enabled);
  revalidatePath("/dashboard/treasury");
}

export async function removeRewardRule(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const ruleId = String(formData.get("ruleId") ?? "");
  await deleteRewardRule(merchant.id, ruleId);
  revalidatePath("/dashboard/treasury");
}

/**
 * L14-3's step 1 (LLM drafts) — redirects back with the drafted
 * description and a hidden field carrying the ast so the merchant sees
 * exactly what they're about to approve before anything activates. The
 * draft itself is never stored yet; approveDraftedRuleAction below is
 * the only path that writes a row, and it always writes approved: true
 * as a direct consequence of the merchant clicking approve.
 */
export async function draftRewardRule(formData: FormData) {
  const instruction = String(formData.get("instruction") ?? "").trim();
  if (!instruction) fail("Describe the rule you want in plain English.");

  const result = await draftRuleFromInstruction(instruction);
  if (!result.ok) fail(result.reason);

  redirect(`/dashboard/treasury?draft=${encodeURIComponent(JSON.stringify(result.ast))}&draftDescription=${encodeURIComponent(result.description)}`);
}

export async function approveDraftedRuleAction(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const astJson = String(formData.get("astJson") ?? "");
  const priority = Number(formData.get("priority") ?? 0);

  let ast: RuleAst;
  try {
    ast = JSON.parse(astJson);
  } catch {
    fail("Could not read the drafted rule — please draft again.");
  }

  const result = await approveDraftedRule(merchant.id, ast, Number.isFinite(priority) ? priority : 0);
  if (!result.ok) fail(result.reason);

  revalidatePath("/dashboard/treasury");
}

export async function saveModelBudget(formData: FormData) {
  const merchant = await requireSessionMerchant();
  const useCase = String(formData.get("useCase") ?? "");
  const budgetRupees = Number(formData.get("budgetRupees"));

  if (!["support_chat", "recovery_diagnosis", "negotiation", "classification"].includes(useCase)) fail("Unknown use case.");
  if (!Number.isFinite(budgetRupees) || budgetRupees < 0) fail("Budget must be a non-negative amount.");

  await setModelBudget(merchant.id, useCase as Parameters<typeof setModelBudget>[1], Math.round(budgetRupees * 100));
  revalidatePath("/dashboard/treasury");
}
