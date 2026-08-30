import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, sweepAbandonedReservations } from "@/lib/gate";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Layer 23-2: proves the gap sweepAbandonedReservations exists to close
 * — a money_actions row stranded at status "allowed" (budget and stock
 * already reserved, executeAndSettle never ran to completion because the
 * process died) is released, exactly once, with an audit trail, and a
 * reservation that is NOT yet expired is left alone. No mocks: real DB,
 * real spend caps, real product stock.
 */

async function makeMerchant() {
  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: `__reservation_sweep_test_${Date.now()}_${Math.random()}__`,
      email: `reservation_sweep_test_${Date.now()}_${Math.random()}@test.invalid`,
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
      name: "__reservation_sweep_test_agent__",
      apiKeyHash: `test_${Date.now()}_${Math.random()}`,
      status: "active",
    })
    .returning();
  return agent;
}

async function makeCap(agentId: string, capPaise = 10_000_000) {
  const now = new Date();
  const [cap] = await db
    .insert(schema.spendCaps)
    .values({
      agentId,
      capPaise,
      spentPaise: 0,
      perTransactionMaxPaise: capPaise,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "active",
    })
    .returning();
  return cap;
}

async function makeVariant(merchantId: string, stock = 10) {
  const [product] = await db
    .insert(schema.products)
    .values({ merchantId, name: "__test product__", description: "test", status: "active" })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      merchantId,
      sku: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pricePaise: 85_000,
      costPaise: 40_000,
      stock,
      status: "active",
    })
    .returning();

  return { product, variant };
}

/**
 * Simulates a reservation whose process died between "allowed" and
 * executeAndSettle ever resolving it — reserves budget and stock exactly
 * how attemptMoneyAction does internally, then backdates
 * reservationExpiresAt into the past so the sweep finds it due.
 */
async function makeStrandedReservation(opts: {
  merchantId: string;
  agentId: string;
  capId: string;
  variantId?: string;
  amountPaise: number;
  quantity?: number;
  expiresInThePast?: boolean;
}) {
  await db
    .update(schema.spendCaps)
    .set({ spentPaise: sql`${schema.spendCaps.spentPaise} + ${opts.amountPaise}` })
    .where(eq(schema.spendCaps.id, opts.capId));

  if (opts.variantId) {
    await db
      .update(schema.productVariants)
      .set({ stock: sql`${schema.productVariants.stock} - ${opts.quantity ?? 1}` })
      .where(eq(schema.productVariants.id, opts.variantId));
  }

  const [moneyAction] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId: opts.merchantId,
      agentId: opts.agentId,
      variantId: opts.variantId,
      quantity: opts.quantity ?? 1,
      type: "order_create",
      amountPaise: opts.amountPaise,
      status: "allowed",
      reservationExpiresAt: opts.expiresInThePast
        ? sql`now() - interval '1 minute'`
        : sql`now() + interval '1 hour'`,
    })
    .returning();

  return moneyAction;
}

describe("sweepAbandonedReservations", () => {
  let merchantId: string | undefined;
  let agentIds: string[] = [];
  let productIds: string[] = [];

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentIds = agentIds;
    const currentProductIds = productIds;
    merchantId = undefined;
    agentIds = [];
    productIds = [];

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
    if (currentProductIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, currentProductIds));
      await db.delete(schema.products).where(inArray(schema.products.id, currentProductIds));
    }
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  it("releases budget and stock for a reservation stranded past its deadline, and audits why", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id);
    const { product, variant } = await makeVariant(merchantId, 5);
    productIds.push(product.id);

    const stranded = await makeStrandedReservation({
      merchantId,
      agentId: agent.id,
      capId: cap.id,
      variantId: variant.id,
      amountPaise: 85_000,
      quantity: 2,
      expiresInThePast: true,
    });

    const { swept } = await sweepAbandonedReservations();
    expect(swept).toBeGreaterThanOrEqual(1);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(0);

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(5);

    const [updatedAction] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, stranded.id));
    expect(updatedAction.status).toBe("failed");
    expect(updatedAction.reservationExpiresAt).toBeNull();

    const [auditEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.moneyActionId, stranded.id));
    expect(auditEntry.event).toBe("reservation_abandoned");
    expect(auditEntry.boundApplied).toBe("reservation_timeout");
  }, 30_000);

  it("leaves a reservation that has not yet expired untouched", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id);
    const { product, variant } = await makeVariant(merchantId, 5);
    productIds.push(product.id);

    const fresh = await makeStrandedReservation({
      merchantId,
      agentId: agent.id,
      capId: cap.id,
      variantId: variant.id,
      amountPaise: 85_000,
      quantity: 1,
      expiresInThePast: false,
    });

    await sweepAbandonedReservations();

    const [untouched] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, fresh.id));
    expect(untouched.status).toBe("allowed");
    expect(untouched.reservationExpiresAt).not.toBeNull();

    const [cap2] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(cap2.spentPaise).toBe(85_000);
  }, 30_000);

  it("is idempotent under two overlapping sweeps — the reservation is released exactly once", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id);
    const { product, variant } = await makeVariant(merchantId, 5);
    productIds.push(product.id);

    const stranded = await makeStrandedReservation({
      merchantId,
      agentId: agent.id,
      capId: cap.id,
      variantId: variant.id,
      amountPaise: 85_000,
      quantity: 1,
      expiresInThePast: true,
    });

    const [resultA, resultB] = await Promise.all([sweepAbandonedReservations(), sweepAbandonedReservations()]);
    // The conditional UPDATE's WHERE re-checks status = 'allowed', so
    // only one of the two concurrent sweeps can claim this row.
    expect(resultA.swept + resultB.swept).toBe(1);

    const [updatedCap] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(updatedCap.spentPaise).toBe(0);

    const [updatedVariant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
    expect(updatedVariant.stock).toBe(5);

    const auditEntries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.moneyActionId, stranded.id));
    expect(auditEntries.length).toBe(1);
  }, 30_000);

  it("a real attemptMoneyAction purchase that completes normally is never picked up by the sweep", async () => {
    const merchant = await makeMerchant();
    merchantId = merchant.id;
    const agent = await makeAgent(merchantId);
    agentIds.push(agent.id);
    const cap = await makeCap(agent.id);
    const { product, variant } = await makeVariant(merchantId, 5);
    productIds.push(product.id);

    const result = await attemptMoneyAction({
      agentId: agent.id,
      merchantId,
      type: "order_create",
      amountPaise: 85_000,
      context: "test product",
      variantId: variant.id,
      quantity: 1,
    });
    expect(result.decision).toBe("allow");

    const [action] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, result.moneyActionId!));
    expect(action.status).toBe("executed");
    expect(action.reservationExpiresAt).toBeNull();

    const { swept } = await sweepAbandonedReservations();
    expect(swept).toBe(0);

    const [cap2] = await db.select().from(schema.spendCaps).where(eq(schema.spendCaps.id, cap.id));
    expect(cap2.spentPaise).toBe(85_000); // still charged, sweep didn't touch it
  }, 30_000);
});
