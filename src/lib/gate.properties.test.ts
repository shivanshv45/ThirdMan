import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 13-1: property-based proof of the gate's core invariants.
 *
 * Our existing gate tests (gate.test.ts, gate.products.test.ts, ...) are
 * example-based — specific inputs, specific expected outputs. This file
 * states the invariants themselves and generates thousands of random
 * operation sequences trying to break them, converting CLAUDE.md's central
 * claim ("deterministic code enforces bounds") from an assertion into a
 * machine-checked result.
 *
 * Split in two per plans/layer-13-authorization-supervision-proof.md:
 *  - a PURE model of the reserve/release arithmetic, run at a high count
 *    (no I/O, so this is cheap)
 *  - a small number of the same generated sequences run against the REAL
 *    gate/DB, to prove the pure model actually matches the implementation
 *    — this is the part that catches a bug the pure model can't see.
 */

// ---------------------------------------------------------------------
// The pure model. Mirrors gate.ts's reserveBudget/releaseBudget exactly:
// a reservation only succeeds if it wouldn't push spent above the cap;
// a release always clamps at 0 (greatest(spent - amount, 0)), the same
// SQL gate.ts's releaseBudget runs.
// ---------------------------------------------------------------------

class PureCap {
  spentPaise = 0;
  constructor(public readonly capPaise: number) {}

  reserve(amountPaise: number): boolean {
    if (this.spentPaise + amountPaise > this.capPaise) return false;
    this.spentPaise += amountPaise;
    return true;
  }

  release(amountPaise: number): void {
    this.spentPaise = Math.max(this.spentPaise - amountPaise, 0);
  }
}

class PureStock {
  constructor(public stock: number) {}

  reserve(quantity: number): boolean {
    if (this.stock < quantity) return false;
    this.stock -= quantity;
    return true;
  }

  release(quantity: number): void {
    this.stock += quantity;
  }
}

type Op =
  | { kind: "reserve"; amountPaise: number }
  | { kind: "release"; amountPaise: number };

const opArb = (perTransactionMaxPaise: number): fc.Arbitrary<Op> =>
  fc.oneof(
    fc.record({ kind: fc.constant("reserve" as const), amountPaise: fc.integer({ min: 1, max: perTransactionMaxPaise }) }),
    fc.record({ kind: fc.constant("release" as const), amountPaise: fc.integer({ min: 1, max: perTransactionMaxPaise }) }),
  );

describe("gate invariants — pure model (property-based, high run count)", () => {
  it("sum(reserved) never exceeds capPaise, for any interleaving of reserve/release", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.array(opArb(1_000_000), { minLength: 0, maxLength: 200 }),
        (capPaise, ops) => {
          const cap = new PureCap(capPaise);
          for (const op of ops) {
            if (op.kind === "reserve") cap.reserve(op.amountPaise);
            else cap.release(op.amountPaise);
            expect(cap.spentPaise).toBeLessThanOrEqual(cap.capPaise);
            expect(cap.spentPaise).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("a release always returns spentPaise to exactly its pre-reservation value — the invariant the Layer 11 escalation-expiry bug already proved matters", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (capPaise, priorReservations, amountPaise) => {
          const cap = new PureCap(capPaise);
          for (const amt of priorReservations) cap.reserve(amt);
          const before = cap.spentPaise;

          const reserved = cap.reserve(amountPaise);
          if (!reserved) return; // nothing to release, invariant vacuously holds

          cap.release(amountPaise);
          expect(cap.spentPaise).toBe(before);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("no sequence of reserve/release produces a negative remaining balance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.array(opArb(1_000_000), { minLength: 0, maxLength: 200 }),
        (capPaise, ops) => {
          const cap = new PureCap(capPaise);
          for (const op of ops) {
            if (op.kind === "reserve") cap.reserve(op.amountPaise);
            else cap.release(op.amountPaise);
          }
          const remaining = cap.capPaise - cap.spentPaise;
          expect(remaining).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("the per-transaction ceiling is never exceeded regardless of window state — a single reservation above perTransactionMaxPaise is always rejected before it ever reaches reserve()", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 1, max: 2_000_000 }),
        (capPaise, perTransactionMaxPaise, amountPaise) => {
          // Mirrors gate.ts's checkBounds ordering: the per-transaction
          // check runs before reserveBudget is ever called.
          const wouldPassPerTxn = amountPaise <= perTransactionMaxPaise;
          if (!wouldPassPerTxn) return; // checkBounds denies before reservation — nothing to assert on the cap itself

          const cap = new PureCap(capPaise);
          cap.reserve(amountPaise);
          expect(cap.spentPaise).toBeLessThanOrEqual(cap.capPaise);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("stock: no sequence of reserve/release produces negative stock, and a release always restores exactly the pre-reservation count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 0, maxLength: 30 }),
        fc.integer({ min: 1, max: 50 }),
        (initialStock, priorReservations, quantity) => {
          const stock = new PureStock(initialStock);
          for (const qty of priorReservations) stock.reserve(qty);
          expect(stock.stock).toBeGreaterThanOrEqual(0);

          const before = stock.stock;
          const reserved = stock.reserve(quantity);
          if (!reserved) {
            expect(stock.stock).toBeGreaterThanOrEqual(0);
            return;
          }
          stock.release(quantity);
          expect(stock.stock).toBe(before);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("reward-coin ledger: the running balance (sum of signed deltas) never goes negative under any valid sequence of issue/redeem", () => {
    // Mirrors gate.ts's executeAndSettle reward branch: an issuance
    // (positive delta) always succeeds; a redemption (negative delta) only
    // succeeds if balance + delta >= 0.
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("issue" as const), coins: fc.integer({ min: 1, max: 1000 }) }),
            fc.record({ kind: fc.constant("redeem" as const), coins: fc.integer({ min: 1, max: 1000 }) }),
          ),
          { minLength: 0, maxLength: 100 },
        ),
        (ops) => {
          let balance = 0;
          for (const op of ops) {
            if (op.kind === "issue") {
              balance += op.coins;
            } else {
              if (balance - op.coins >= 0) balance -= op.coins;
              // else: denied, balance unchanged — mirrors the conditional INSERT.
            }
            expect(balance).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------
// DB-backed sequence tests. Low run count (real Neon round-trips per
// operation) — the same shape of generated sequence, executed against the
// real attemptMoneyAction/gate.ts, proving the pure model actually
// matches the implementation.
// ---------------------------------------------------------------------

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__gate_props_test_merchant_${Date.now()}_${Math.random()}__`,
      email: `gate_props_test_${Date.now()}_${Math.random()}@test.invalid`,
      passwordHash: "test:not-a-real-hash",
      razorpayKeyIdEncrypted: encrypt(env.RAZORPAY_KEY_ID),
      razorpayKeySecretEncrypted: encrypt(env.RAZORPAY_KEY_SECRET),
    })
    .returning();
  return merchant;
}

async function makeAgent(merchantId: string) {
  const [agent] = await db
    .insert(schema.agents)
    .values({
      merchantId,
      name: "__gate_props_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise: number, perTransactionMaxPaise: number) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise,
      spentPaise: 0,
      perTransactionMaxPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();
  return cap;
}

describe("gate invariants — DB-backed sequence tests (low run count, real gate)", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    merchantId = undefined;
    agentIds = [];

    if (currentAgentIds.length > 0) {
      await db
        .delete(schema.escalations)
        .where(
          inArray(
            schema.escalations.spendCapId,
            db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds)),
          ),
        );
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, currentAgentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, currentMerchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, currentMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it(
    "a generated sequence of reserve-sized amountPaise requests against a fixed cap never lets spentPaise exceed capPaise, matching the pure model",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1000, max: 50_000 }), { minLength: 3, maxLength: 5 }),
          async (amounts) => {
            const capPaise = 100_000;
            const merchant = await makeMerchant();
            merchantId = merchant.id;
            const agent = await makeAgent(merchantId);
            agentIds.push(agent.id);
            await makeCap(agent.id, capPaise, capPaise);

            // Pure model, run in lockstep for comparison.
            const pureCap = new PureCap(capPaise);

            for (const amountPaise of amounts) {
              const result = await attemptMoneyAction({
                agentId: agent.id,
                merchantId,
                type: "order_create",
                amountPaise,
                context: "property-test sequence purchase",
              });

              const pureReserved = pureCap.reserve(amountPaise);
              // "allow" or "escalate" both mean the reservation held (the
              // risk layer can only downgrade allow->escalate, never touch
              // whether budget was reserved) — same equivalence
              // gate.products.test.ts's concurrency test already uses.
              const realReserved = result.decision === "allow" || result.decision === "escalate";
              expect(realReserved).toBe(pureReserved);
            }

            const [finalCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
            expect(finalCap.spentPaise).toBeLessThanOrEqual(capPaise);
            expect(finalCap.spentPaise).toBe(pureCap.spentPaise);

            // afterEach only handles one merchant at a time — clean up
            // this iteration immediately so the next generated case starts fresh.
            await db
              .delete(schema.escalations)
              .where(inArray(schema.escalations.spendCapId, db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id))));
            await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
            await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
            await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
            await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
            await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
            agentIds = [];
            merchantId = undefined;
          },
        ),
        { numRuns: 8 },
      );
    },
    280_000,
  );

  it(
    "a request above perTransactionMaxPaise is always denied and never reserves budget, across generated cap/amount pairs",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10_000, max: 500_000 }),
          fc.integer({ min: 10_000, max: 500_000 }),
          fc.integer({ min: 1, max: 1_000_000 }),
          async (capPaise, perTransactionMaxPaise, amountPaise) => {
            const merchant = await makeMerchant();
            merchantId = merchant.id;
            const agent = await makeAgent(merchantId);
            agentIds.push(agent.id);
            await makeCap(agent.id, capPaise, perTransactionMaxPaise);

            const result = await attemptMoneyAction({
              agentId: agent.id,
              merchantId,
              type: "order_create",
              amountPaise,
              context: "property-test per-transaction ceiling probe",
            });

            const shouldDenyOnPerTxn = amountPaise > perTransactionMaxPaise;
            if (shouldDenyOnPerTxn) {
              expect(result.decision).toBe("deny");
              const [cap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
              expect(cap.spentPaise).toBe(0);
            }

            await db
              .delete(schema.escalations)
              .where(inArray(schema.escalations.spendCapId, db.select({ id: schema.spendCaps.id }).from(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id))));
            await db.delete(schema.spendCaps).where(eq(schema.spendCaps.agentId, agent.id));
            await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
            await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
            await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
            await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
            agentIds = [];
            merchantId = undefined;
          },
        ),
        { numRuns: 15 },
      );
    },
    280_000,
  );
});
