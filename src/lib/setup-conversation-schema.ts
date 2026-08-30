import { z } from "zod";
import { schema } from "@/lib/db";

/**
 * The closed shape a setup-conversation proposal must match — shared
 * between setup-conversation.ts (drafts, never writes) and
 * setup-conversation-confirm.ts (writes, never calls a model), so the
 * two can never validate against different grammars. Neither of those
 * two files imports the other — see setup-conversation.isolation.test.ts.
 */

const agentCapabilityEnum = z.enum(schema.agentCapabilityEnum.enumValues as [string, ...string[]]);

const proposedAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(300),
  suggestedCapRupees: z.number().positive().finite(),
  capReason: z.string().trim().min(1).max(300),
  suggestedPerTransactionMaxRupees: z.number().positive().finite(),
  capabilities: z.array(agentCapabilityEnum).min(1).max(schema.agentCapabilityEnum.enumValues.length),
});

export const proposalSchema = z.object({
  agents: z.array(proposedAgentSchema).min(1).max(5),
});

export type ProposedAgent = z.infer<typeof proposedAgentSchema>;
export type SetupProposal = z.infer<typeof proposalSchema>;

export const SCHEMA_DESCRIPTION = `{"agents": [{"name": string, "purpose": string (one sentence, in the merchant's own words), "suggestedCapRupees": number, "capReason": string (why this starting number, one sentence), "suggestedPerTransactionMaxRupees": number (must be <= suggestedCapRupees), "capabilities": string[] (chosen ONLY from: "products:read", "policy:read", "offers:read", "rewards:read", "rewards:redeem", "negotiation:create", "purchase:create")}]}. Propose at most 5 agents. Every capability list must be the MINIMUM needed for the stated purpose — never grant "negotiation:create" or "rewards:redeem" unless the merchant's own words specifically call for negotiating or handling reward coins. An agent that only needs to look things up gets read capabilities and no purchase:create. Cap suggestions should be conservative for a first-time setup — a few thousand rupees, not tens of thousands, unless the merchant states a larger number themselves.`;
