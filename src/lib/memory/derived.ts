import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCoinBalance } from "@/lib/reward-coins";
import { formatPaise } from "@/lib/money";

/**
 * Derived memory (Layer 18-2) — a cache over facts this codebase already
 * owns, computed by deterministic code, never a model. See
 * plans/layer-18-memory-bank.md's "second rule": a memory is a record of
 * something that really happened, not an opinion about a person.
 *
 * costPaise and margin are never read into this module, not even
 * internally — a field that exists is a field that can leak (CLAUDE.md
 * rule 1, cost-paise-never-leaks.test.ts's guarantee).
 *
 * Every derived key below is confirmed immediately at write time
 * (recomputeDerivedMemory): it's code-computed, so there is nothing for
 * a human to review before it's trustworthy — confirmation only gates
 * stated memories (stated.ts), which originate from an untrusted party.
 */

export const DERIVED_MEMORY_KEYS = [
  "prior_purchase_summary",
  "reward_coin_balance",
  "past_negotiation_outcome",
  "outstanding_restock_request",
] as const;

export type DerivedMemoryKey = (typeof DERIVED_MEMORY_KEYS)[number];

export type MemorySubjectType = "customer_contact" | "agent";

export interface DerivedFact {
  key: DerivedMemoryKey;
  value: string;
  sourceType: string;
  sourceId: string;
}

/**
 * Prior captured purchases for a customer_contact subject only join
 * through conversations (money_actions has no direct customerContactId —
 * see ARCHITECTURE.md's Memory Bank section for why). An agent subject's
 * purchases are its own money_actions rows directly. Either way: only
 * "captured" actions count as a real purchase, never a pending/failed one.
 */
async function computePriorPurchaseSummary(
  merchantId: string,
  subjectType: MemorySubjectType,
  subjectId: string,
): Promise<DerivedFact | null> {
  const rows =
    subjectType === "agent"
      ? await db
          .select({ id: schema.moneyActions.id, amountPaise: schema.moneyActions.amountPaise, createdAt: schema.moneyActions.createdAt })
          .from(schema.moneyActions)
          .where(
            and(
              eq(schema.moneyActions.merchantId, merchantId),
              eq(schema.moneyActions.agentId, subjectId),
              eq(schema.moneyActions.status, "captured"),
            ),
          )
          .orderBy(desc(schema.moneyActions.createdAt))
      : await db
          .select({ id: schema.moneyActions.id, amountPaise: schema.moneyActions.amountPaise, createdAt: schema.moneyActions.createdAt })
          .from(schema.moneyActions)
          .innerJoin(schema.cartPurchases, eq(schema.moneyActions.cartId, schema.cartPurchases.id))
          .innerJoin(schema.conversations, eq(schema.cartPurchases.conversationId, schema.conversations.id))
          .where(
            and(
              eq(schema.moneyActions.merchantId, merchantId),
              eq(schema.conversations.customerContactId, subjectId),
              eq(schema.moneyActions.status, "captured"),
            ),
          )
          .orderBy(desc(schema.moneyActions.createdAt));

  if (rows.length === 0) return null;

  const [mostRecent] = rows;
  return {
    key: "prior_purchase_summary",
    value: `${rows.length} prior captured purchase${rows.length === 1 ? "" : "s"}, most recent ${formatPaise(mostRecent.amountPaise)} on ${mostRecent.createdAt.toISOString().slice(0, 10)}`,
    sourceType: "money_action",
    sourceId: mostRecent.id,
  };
}

async function computeRewardCoinBalance(
  merchantId: string,
  subjectType: MemorySubjectType,
  subjectId: string,
): Promise<DerivedFact | null> {
  const identity = subjectType === "agent" ? { agentId: subjectId } : {};
  if (subjectType === "customer_contact") {
    // getCoinBalance only recognises agentId/sessionToken identities
    // (reward-coins.ts's RewardIdentity) — a customer_contact has no
    // direct ledger join today, so this fact is genuinely unavailable
    // for that subject rather than estimated. See ARCHITECTURE.md.
    return null;
  }
  const balance = await getCoinBalance(merchantId, identity);
  if (balance === 0) return null;
  return {
    key: "reward_coin_balance",
    value: `${balance} reward coin${balance === 1 ? "" : "s"}`,
    sourceType: "reward_coin_ledger",
    sourceId: subjectId,
  };
}

async function computePastNegotiationOutcome(
  merchantId: string,
  subjectType: MemorySubjectType,
  subjectId: string,
): Promise<DerivedFact | null> {
  const rows =
    subjectType === "agent"
      ? await db
          .select({
            id: schema.negotiations.id,
            status: schema.negotiations.status,
            agreedUnitPricePaise: schema.negotiations.agreedUnitPricePaise,
            resolvedAt: schema.negotiations.resolvedAt,
          })
          .from(schema.negotiations)
          .where(and(eq(schema.negotiations.merchantId, merchantId), eq(schema.negotiations.agentId, subjectId)))
          .orderBy(desc(schema.negotiations.createdAt))
      : await db
          .select({
            id: schema.negotiations.id,
            status: schema.negotiations.status,
            agreedUnitPricePaise: schema.negotiations.agreedUnitPricePaise,
            resolvedAt: schema.negotiations.resolvedAt,
          })
          .from(schema.negotiations)
          .innerJoin(schema.conversations, eq(schema.negotiations.sessionToken, schema.conversations.sessionToken))
          .where(and(eq(schema.negotiations.merchantId, merchantId), eq(schema.conversations.customerContactId, subjectId)))
          .orderBy(desc(schema.negotiations.createdAt));

  const resolved = rows.find((r) => r.status === "agreed" || r.status === "expired" || r.status === "refused_turns_exhausted");
  if (!resolved) return null;

  const value =
    resolved.status === "agreed" && resolved.agreedUnitPricePaise !== null
      ? `last negotiation agreed at ${formatPaise(resolved.agreedUnitPricePaise)}/unit`
      : `last negotiation ${resolved.status}`;

  return { key: "past_negotiation_outcome", value, sourceType: "negotiation", sourceId: resolved.id };
}

async function computeOutstandingRestockRequest(
  merchantId: string,
  subjectType: MemorySubjectType,
  subjectId: string,
): Promise<DerivedFact | null> {
  if (subjectType !== "customer_contact") return null;

  const [row] = await db
    .select({ id: schema.restockRequests.id, variantId: schema.restockRequests.variantId, requestedAt: schema.restockRequests.requestedAt })
    .from(schema.restockRequests)
    .where(
      and(
        eq(schema.restockRequests.merchantId, merchantId),
        eq(schema.restockRequests.contactId, subjectId),
        eq(schema.restockRequests.status, "waiting"),
      ),
    )
    .orderBy(desc(schema.restockRequests.requestedAt))
    .limit(1);

  if (!row) return null;
  return { key: "outstanding_restock_request", value: "waiting on a restock alert for a variant currently out of stock", sourceType: "restock_request", sourceId: row.id };
}

/**
 * Recomputes every derived fact for one subject and upserts each into
 * agent_memories. A fact that no longer applies (e.g. balance spent to
 * zero) is deleted rather than left stale — this module owns the
 * derived rows for a subject completely; nothing else writes kind:
 * "derived".
 */
export async function recomputeDerivedMemory(merchantId: string, subjectType: MemorySubjectType, subjectId: string): Promise<void> {
  const facts = (
    await Promise.all([
      computePriorPurchaseSummary(merchantId, subjectType, subjectId),
      computeRewardCoinBalance(merchantId, subjectType, subjectId),
      computePastNegotiationOutcome(merchantId, subjectType, subjectId),
      computeOutstandingRestockRequest(merchantId, subjectType, subjectId),
    ])
  ).filter((f): f is DerivedFact => f !== null);

  const presentKeys = new Set(facts.map((f) => f.key));
  const staleKeys = DERIVED_MEMORY_KEYS.filter((k) => !presentKeys.has(k));

  await db.transaction(async (tx) => {
    for (const fact of facts) {
      await tx
        .insert(schema.agentMemories)
        .values({
          merchantId,
          subjectType,
          subjectId,
          kind: "derived",
          key: fact.key,
          value: fact.value,
          sourceType: fact.sourceType,
          sourceId: fact.sourceId,
          confirmedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [schema.agentMemories.merchantId, schema.agentMemories.subjectType, schema.agentMemories.subjectId, schema.agentMemories.key],
          set: {
            value: fact.value,
            sourceType: fact.sourceType,
            sourceId: fact.sourceId,
            confirmedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
    }
    if (staleKeys.length > 0) {
      await tx
        .delete(schema.agentMemories)
        .where(
          and(
            eq(schema.agentMemories.merchantId, merchantId),
            eq(schema.agentMemories.subjectType, subjectType),
            eq(schema.agentMemories.subjectId, subjectId),
            eq(schema.agentMemories.kind, "derived"),
            sql`${schema.agentMemories.key} = ANY(${staleKeys})`,
          ),
        );
    }
  });
}
