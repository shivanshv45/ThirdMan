import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { getMerchantAgentTerms } from "@/lib/agent-terms";

/**
 * Layer 21-8: self-serve agent registration. A provisional agent is an
 * ORDINARY agents row with small, merchant-configured numbers — not a
 * new trust tier or a parallel code path. It transacts through the same
 * gate, is capped by the same spend_caps table, and is bounded by the
 * same merchant_agent_terms this module reads (unknownAgentsAllowed,
 * newAgentOrderCeilingPaise — see gate.ts's checkAgentTerms) once it
 * starts making requests.
 *
 * Registration itself is closed by default: a merchant who has
 * published no terms, or has terms with selfRegistrationOpen: false,
 * accepts no self-registrations — fail closed applied to onboarding,
 * per the plan's explicit instruction. The caller (the route) is
 * responsible for rate-limiting hard, per IP and per merchant — this is
 * an unauthenticated endpoint that creates rows, the classic abuse
 * surface.
 */

export type RegisterAgentResult =
  | { ok: true; agent: typeof schema.agents.$inferSelect; rawKey: string }
  | { ok: false; reason: string };

export async function registerAgent(merchantId: string, name: string, registeredIp: string): Promise<RegisterAgentResult> {
  const terms = await getMerchantAgentTerms(merchantId);

  // Fail closed: no terms row, or terms that don't open registration,
  // both mean "no self-registration path exists" — the same "absence is
  // real, not permissive" discipline every field in this table follows.
  if (!terms || !terms.selfRegistrationOpen) {
    return { ok: false, reason: "This merchant does not accept self-registered agents." };
  }

  // setMerchantAgentTerms already refuses to open registration without
  // both of these set, but a defensive re-check here means this
  // function is correct even if that invariant is ever violated by a
  // future caller — a provisional agent with purchase:create and no cap
  // is exactly the gap this layer must never produce.
  if (terms.selfRegisterStartingCapPaise === null || terms.selfRegisterPerTransactionMaxPaise === null) {
    return { ok: false, reason: "This merchant's self-registration terms are misconfigured (no starting cap). Registration is refused rather than guessed." };
  }

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { ok: false, reason: "A name is required." };
  }

  const rawKey = generateApiKey();

  const agent = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.agents)
      .values({
        merchantId,
        name: trimmedName,
        apiKeyHash: hashApiKey(rawKey),
        status: "active",
        registrationSource: "self_registered",
        registeredIp,
      })
      .returning();

    const now = new Date();
    await tx.insert(schema.spendCaps).values({
      agentId: created.id,
      // The merchant's own numbers, never a hardcoded default this
      // layer picks — checked non-null above.
      capPaise: terms.selfRegisterStartingCapPaise!,
      spentPaise: 0,
      perTransactionMaxPaise: terms.selfRegisterPerTransactionMaxPaise!,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    });

    // The merchant's own configured default set, deduped against the
    // real enum the same way setAgentCapabilities does — never
    // "purchase:create alone" by construction of that config elsewhere,
    // but defended here too rather than trusted blindly.
    const validCapabilities = new Set(schema.agentCapabilityEnum.enumValues);
    const capabilities = terms.selfRegisterDefaultCapabilities.filter((c) => validCapabilities.has(c));
    if (capabilities.length > 0) {
      await tx.insert(schema.agentCapabilities).values(capabilities.map((capability) => ({ agentId: created.id, capability })));
    }

    return created;
  });

  await logAuditEntry({
    merchantId,
    actor: "agent",
    event: "agent_self_registered",
    decision: "n/a",
    reason: `An agent self-registered as "${agent.name}" and was issued a provisional key: ₹${(terms.selfRegisterStartingCapPaise! / 100).toFixed(2)} starting cap, ${terms.selfRegisterDefaultCapabilities.length} capabilit${terms.selfRegisterDefaultCapabilities.length === 1 ? "y" : "ies"} granted.`,
    metadata: { agentId: agent.id, registeredIp, capabilities: terms.selfRegisterDefaultCapabilities },
  });

  return { ok: true, agent, rawKey };
}
