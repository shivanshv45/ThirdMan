import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { draftSetupProposal } from "@/lib/setup-conversation";

/**
 * Layer 24's headline failure demo (plans/layer-24-onboarding-surfaces.md's
 * L24-12): the same headline shape as Layer 22's returns demo — the
 * model said yes, and nothing moved. The setup conversation is asked to
 * propose a generous fleet of agents with real spend caps; whatever it
 * proposes, ending here (a drafted proposal, unconfirmed) is the whole
 * point — draftSetupProposal has no capability to write a row at all.
 *
 * This isn't a mocked model response — it's a real Groq call. What
 * matters isn't what the model actually proposed; it's that
 * setup-conversation.ts (the module holding that call) has zero import
 * of setup-conversation-confirm.ts, the only module that ever writes an
 * agents/spend_caps/agent_capabilities row — see
 * setup-conversation.isolation.test.ts for the static proof this demo
 * makes visible end to end.
 */
async function main() {
  console.log("=== Demo: whatever the assistant proposes, nothing is created until the merchant confirms ===\n");

  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const agentsBefore = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchant.id));
  console.log(`1. Merchant currently has ${agentsBefore.length} agent(s).\n`);

  const instruction = "Set up a generous fleet: one agent to handle recovery with a big budget, one that can negotiate deep discounts, and one that can redeem reward coins freely — give them all plenty of room to work with.";
  console.log(`2. Merchant describes what they want, deliberately asking for generous caps:\n   "${instruction}"\n`);

  console.log("3. Asking the assistant to draft a proposal (a real Groq call, not mocked):");
  const draft = await draftSetupProposal(merchant.id, instruction);

  if (!draft.ok) {
    console.log(`   Draft was refused: ${draft.reason}`);
    console.log("\n   Even a refused draft never wrote anything — there was nothing to roll back.");
  } else {
    console.log(`   Proposed ${draft.proposal.agents.length} agent(s):`);
    for (const agent of draft.proposal.agents) {
      console.log(`   - "${agent.name}": ₹${agent.suggestedCapRupees} cap, capabilities [${agent.capabilities.join(", ")}]`);
    }
  }

  console.log("\n4. Reading back the merchant's real agents after the draft — nothing has changed:");
  const agentsAfter = await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.merchantId, merchant.id));
  console.log(`   ${agentsAfter.length} agent(s) — identical to before the draft.`);

  if (agentsAfter.length !== agentsBefore.length) {
    throw new Error(`Expected agent count unchanged at ${agentsBefore.length}, got ${agentsAfter.length} — demo scenario is broken`);
  }

  const auditRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
  const anyConfirmedEvent = auditRows.some((r) => r.event === "setup_conversation_confirmed");
  if (anyConfirmedEvent) {
    console.log("\n   NOTE: a setup_conversation_confirmed audit entry already existed for this merchant from prior real use — that's expected on a merchant who has actually confirmed a proposal before; this run itself created none.");
  }

  console.log(
    "\nWhatever the assistant proposed, it has no function it can call that writes an agent, a spend cap, or a capability grant. setup-conversation.ts, the module holding this exact call, has zero import of setup-conversation-confirm.ts. Only a merchant's own click on /dashboard/setup-conversation reaches createProposedAgents.",
  );

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
