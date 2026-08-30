import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { db, schema } from "@/lib/db";
import { simulateBoundChange } from "@/lib/bound-simulator";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 25-1's two required proofs, per
 * plans/layer-25-control-surfaces.md:
 * 1. The simulator's replay respects SEQUENTIAL cap consumption — a
 *    fixture where the naive per-attempt answer differs from the
 *    correct sequential one.
 * 2. The simulator calls gate.ts's own arithmetic, not a copy — a
 *    static check that bound-simulator.ts imports checkCapArithmetic
 *    from gate.ts rather than reimplementing the comparison.
 */

describe("bound-simulator.ts calls gate.ts's own arithmetic", () => {
  it("imports checkCapArithmetic from gate.ts rather than reimplementing it", () => {
    const source = readFileSync(new URL("./bound-simulator.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/checkCapArithmetic[\s\S]*from ["']@\/lib\/gate["']/);
  });
});

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__simulator_test_${Date.now()}_${Math.random()}__`,
      email: `simulator_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__simulator_test_agent__", apiKeyHash: `sim_test_${Date.now()}_${Math.random()}`, status: "active" })
    .returning();
  return agent;
}

/** Directly writes a money_action_attempt audit row, bypassing the real gate — these tests are about the simulator's own replay arithmetic, not about driving a live gate call. */
async function recordAttempt(merchantId: string, agentId: string, amountPaise: number, decision: "allow" | "deny", boundApplied: string | null) {
  await logAuditEntry({
    merchantId,
    actor: "agent",
    event: "money_action_attempt:order_create",
    decision,
    reason: decision === "allow" ? `Allowed — ₹${(amountPaise / 100).toFixed(2)}` : `Denied — over the cap`,
    boundApplied: boundApplied ?? undefined,
    metadata: { agentId, amountPaise },
  });
  // Attempts must be strictly ordered by createdAt for the sequential
  // replay to mean anything — a small real sleep guarantees distinct
  // timestamps even on a fast local Postgres instance.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("simulateBoundChange", () => {
  const merchantIds: string[] = [];
  const agentIds: string[] = [];

  afterEach(async () => {
    const currentMerchantIds = [...merchantIds];
    const currentAgentIds = [...agentIds];
    merchantIds.length = 0;
    agentIds.length = 0;

    if (currentAgentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    for (const merchantId of currentMerchantIds) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("respects sequential cap consumption — recovering an earlier denial changes what's available for a LATER attempt, the naive per-attempt answer would get this wrong", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);

    // Real sequence, in order: ₹600 allowed (spends 600 of a real
    // ₹1000 cap), ₹500 DENIED by spend_cap_balance (only ₹400 left),
    // ₹300 allowed (300 of the remaining 400).
    //
    // Under a hypothetical ₹1000 cap with NO per-transaction limit
    // bump: the naive (wrong) answer checks each attempt independently
    // against the full ₹1000 cap and says "₹500 fits, recovered!" —
    // but sequentially, ₹600 already consumed first, leaving only ₹400
    // — ₹500 STILL doesn't fit. Only a genuinely higher cap (say
    // ₹1500) recovers it, and only if the sequential total (600 + 500 +
    // 300 = 1400) still fits under it.
    await recordAttempt(merchant.id, agent.id, 60_000, "allow", null);
    await recordAttempt(merchant.id, agent.id, 50_000, "deny", "spend_cap_balance:fake-cap-id");
    await recordAttempt(merchant.id, agent.id, 30_000, "allow", null);

    // Hypothetical cap of exactly ₹1000 (same as real) — the naive
    // per-attempt check would wrongly say the ₹500 denial is
    // recoverable (500 <= 1000), but sequentially 600 was already
    // spent, leaving only 400 — still denied.
    const naiveCapResult = await simulateBoundChange(agent.id, 100_000, 100_000, 30);
    expect(naiveCapResult.recoveredCount).toBe(0);
    expect(naiveCapResult.stillDeniedCount).toBe(1);

    // A genuinely larger cap of ₹1500 — sequentially: 600 spent, then
    // 500 now fits (600+500=1100 <= 1500), then 300 fits (1100+300=1400
    // <= 1500). The ₹500 denial IS recovered here.
    const largerCapResult = await simulateBoundChange(agent.id, 150_000, 150_000, 30);
    expect(largerCapResult.recoveredCount).toBe(1);
    expect(largerCapResult.recoveredAmountPaise).toBe(50_000);
    expect(largerCapResult.stillDeniedCount).toBe(0);
  }, 20_000);

  it("never counts a non-cap refusal (e.g. guardian) as recovered, even under a very large hypothetical cap", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);

    await recordAttempt(merchant.id, agent.id, 50_000, "deny", "guardian_state:some-agent-id");

    const result = await simulateBoundChange(agent.id, 10_000_000, 10_000_000, 30);
    expect(result.recoveredCount).toBe(0);
    expect(result.nonCapRefusalCount).toBe(1);
  }, 20_000);

  it("returns zero attempts for an agent with no recorded history", async () => {
    const merchant = await makeMerchant();
    merchantIds.push(merchant.id);
    const agent = await makeAgent(merchant.id);
    agentIds.push(agent.id);

    const result = await simulateBoundChange(agent.id, 100_000, 100_000, 30);
    expect(result.attemptsReplayed).toBe(0);
    expect(result.recoveredCount).toBe(0);
  }, 20_000);
});
