import type { schema } from "@/lib/db";

/**
 * Derives a human-readable sentence from the structured policy fields
 * (Layer 5-3) — for display only. Never the other direction: storing
 * prose and asking a model to extract terms at read time would put a
 * model between a buyer and a contractual term. See DECISIONS.md.
 */
export function describeMerchantPolicy(policy: typeof schema.merchantPolicies.$inferSelect | null): string {
  if (!policy) return "This merchant has not published a return policy.";

  if (!policy.returnsAccepted) {
    return "This merchant does not accept returns.";
  }

  const parts: string[] = [
    `Returns accepted within ${policy.returnWindowDays ?? "an unspecified number of"} days.`,
  ];

  if (policy.refundMethod) {
    const methodText = { original_payment_method: "the original payment method", store_credit: "store credit", either: "either the original payment method or store credit" }[policy.refundMethod];
    parts.push(`Refunded via ${methodText}.`);
  }

  if (policy.restockingFeePercent) {
    parts.push(`A ${policy.restockingFeePercent}% restocking fee applies.`);
  }

  if (policy.shippingRegions.length > 0) {
    parts.push(`Ships to: ${policy.shippingRegions.join(", ")}.`);
  }

  if (policy.handlingTimeDays !== null) {
    parts.push(`Orders are handled within ${policy.handlingTimeDays} day(s) before shipping.`);
  }

  if (policy.warrantyMonths !== null) {
    parts.push(`Carries a ${policy.warrantyMonths}-month warranty.`);
  }

  return parts.join(" ");
}
