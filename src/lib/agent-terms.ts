import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 21-7: merchant-authored policy for AI buyers as a CLASS, not per
 * agent. Every field is arithmetic or a boolean, enforced in gate.ts's
 * checkBounds (unknownAgentsAllowed, newAgentOrderCeilingPaise,
 * mandateRequiredAbovePaise) or agent-terms-gated call sites
 * (negotiationOpenToAgents) — none of it is a new KIND of bound, these
 * are merchant-set values feeding checks that already exist.
 *
 * Absence is real: a merchant with no row here has published no terms.
 * getMerchantAgentTerms returns null rather than fabricating a
 * permissive default, matching merchant_policies' own discipline. Every
 * caller of the conservative fields below (self-registration,
 * unknown-agent gating) must treat a null row as "closed"/"not allowed",
 * never as "everything permitted."
 */

export type MerchantAgentTerms = typeof schema.merchantAgentTerms.$inferSelect;

export async function getMerchantAgentTerms(merchantId: string): Promise<MerchantAgentTerms | null> {
  const [terms] = await db.select().from(schema.merchantAgentTerms).where(eq(schema.merchantAgentTerms.merchantId, merchantId));
  return terms ?? null;
}

export interface SetAgentTermsInput {
  merchantId: string;
  unknownAgentsAllowed: boolean;
  newAgentOrderCeilingPaise: number | null;
  mandateRequiredAbovePaise: number | null;
  negotiationOpenToAgents: boolean;
  selfRegisterDefaultCapabilities: (typeof schema.agentCapabilityEnum.enumValues)[number][];
  selfRegistrationOpen: boolean;
  selfRegisterStartingCapPaise: number | null;
  selfRegisterPerTransactionMaxPaise: number | null;
}

function assertNonNegativeInteger(value: number | null, field: string) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${field} must be a non-negative integer number of paise`);
  }
}

/**
 * Full-replace, same shape as setMerchantPolicy/setAgentCapabilities —
 * one form is the whole truth. Opening self-registration with no
 * starting cap configured is refused outright: a provisional agent with
 * purchase:create and no cap would be a real gap, not a merchant choice
 * that can be reasoned about later.
 */
export async function setMerchantAgentTerms(input: SetAgentTermsInput) {
  assertNonNegativeInteger(input.newAgentOrderCeilingPaise, "newAgentOrderCeilingPaise");
  assertNonNegativeInteger(input.mandateRequiredAbovePaise, "mandateRequiredAbovePaise");
  assertNonNegativeInteger(input.selfRegisterStartingCapPaise, "selfRegisterStartingCapPaise");
  assertNonNegativeInteger(input.selfRegisterPerTransactionMaxPaise, "selfRegisterPerTransactionMaxPaise");

  if (
    input.selfRegistrationOpen &&
    (input.selfRegisterStartingCapPaise === null || input.selfRegisterPerTransactionMaxPaise === null)
  ) {
    throw new Error("Self-registration cannot be opened without a starting cap and a per-transaction max");
  }

  const validCapabilities = new Set(schema.agentCapabilityEnum.enumValues);
  const deduped = [...new Set(input.selfRegisterDefaultCapabilities)].filter((c) => validCapabilities.has(c));
  // negotiation:create can only be in the default set when the merchant
  // has separately opened negotiation to machine buyers at all — the
  // same value cannot both forbid negotiation and grant it by default.
  const capabilities = input.negotiationOpenToAgents ? deduped : deduped.filter((c) => c !== "negotiation:create");

  const values = {
    merchantId: input.merchantId,
    unknownAgentsAllowed: input.unknownAgentsAllowed,
    newAgentOrderCeilingPaise: input.newAgentOrderCeilingPaise,
    mandateRequiredAbovePaise: input.mandateRequiredAbovePaise,
    negotiationOpenToAgents: input.negotiationOpenToAgents,
    selfRegisterDefaultCapabilities: capabilities,
    selfRegistrationOpen: input.selfRegistrationOpen,
    selfRegisterStartingCapPaise: input.selfRegisterStartingCapPaise,
    selfRegisterPerTransactionMaxPaise: input.selfRegisterPerTransactionMaxPaise,
    updatedAt: new Date(),
  };

  const existing = await getMerchantAgentTerms(input.merchantId);
  const terms = existing
    ? (await db.update(schema.merchantAgentTerms).set(values).where(eq(schema.merchantAgentTerms.merchantId, input.merchantId)).returning())[0]
    : (await db.insert(schema.merchantAgentTerms).values(values).returning())[0];

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "agent_terms_updated",
    decision: "n/a",
    reason: `Merchant set agent terms: unknown agents ${input.unknownAgentsAllowed ? "allowed" : "not allowed"}, self-registration ${input.selfRegistrationOpen ? "open" : "closed"}, negotiation ${input.negotiationOpenToAgents ? "open" : "closed"} to machine buyers.`,
    metadata: {
      unknownAgentsAllowed: input.unknownAgentsAllowed,
      selfRegistrationOpen: input.selfRegistrationOpen,
      negotiationOpenToAgents: input.negotiationOpenToAgents,
    },
  });

  return terms;
}
