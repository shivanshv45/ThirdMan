import { z } from "zod";

const CAPABILITY_VALUES = [
  "products:read",
  "policy:read",
  "offers:read",
  "rewards:read",
  "rewards:redeem",
  "negotiation:create",
  "purchase:create",
] as const;

export const agentTermsProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_terms"),
    unknownAgentsAllowed: z.boolean(),
    newAgentOrderCeilingRupees: z.number().nonnegative().nullable(),
    mandateRequiredAboveRupees: z.number().nonnegative().nullable(),
    negotiationOpenToAgents: z.boolean(),
    selfRegisterDefaultCapabilities: z.array(z.enum(CAPABILITY_VALUES)),
    selfRegistrationOpen: z.boolean(),
    selfRegisterStartingCapRupees: z.number().nonnegative().nullable(),
    selfRegisterPerTransactionMaxRupees: z.number().nonnegative().nullable(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("clarify"),
    question: z.string(),
  }),
  z.object({
    kind: z.literal("no_action"),
    summary: z.string(),
  }),
]);

export type AgentTermsProposal = z.infer<typeof agentTermsProposalSchema>;

export const AGENT_TERMS_SCHEMA_DESCRIPTION = `
One of:
- set_terms: { kind: "set_terms", unknownAgentsAllowed, newAgentOrderCeilingRupees, mandateRequiredAboveRupees, negotiationOpenToAgents, selfRegisterDefaultCapabilities, selfRegistrationOpen, selfRegisterStartingCapRupees, selfRegisterPerTransactionMaxRupees, summary }
  Replaces the merchant's whole agent-terms policy (what unregistered AI buyers are allowed to do). All rupee fields are plain rupees, not paise, and null means no ceiling configured. selfRegisterDefaultCapabilities is a subset of: ${CAPABILITY_VALUES.join(", ")}. If selfRegistrationOpen is true, both selfRegisterStartingCapRupees and selfRegisterPerTransactionMaxRupees must be non-null. Carry over every field from the current terms the conversation didn't mention, and change only what it asked for.
- clarify: { kind: "clarify", question }
  Use when the merchant wants to open self-registration but hasn't given both required caps, or otherwise wants a change you can't fill in without guessing a number. Ask ONE short question for the single most important missing thing.
- no_action: { kind: "no_action", summary }
  Use when the instruction doesn't relate to agent terms at all. Explain why in summary.
`.trim();
