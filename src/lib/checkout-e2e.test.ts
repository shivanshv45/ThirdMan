import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, confirmCapture } from "@/lib/gate";
import { getRecentAuditEntries } from "@/lib/audit";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * L4-8's required full end-to-end path: create product -> checkout ->
 * capture -> verify -> money_actions.status = captured -> audit trail
 * shows it. Order creation is a real Razorpay test-mode call (same
 * standard as gate.test.ts); confirmCapture is exercised with a
 * synthetic payment id since completing a real Checkout payment needs a
 * browser, same caveat as gate.capture.test.ts — what's proven here is
 * that the full chain, wired together, produces the right end state and
 * a readable audit trail, not a live card payment.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.productVariants).where(eq(schema.productVariants.merchantId, merchantId));
    await db.delete(schema.products).where(eq(schema.products.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("full checkout path: product -> checkout -> capture -> verify -> status", () => {
  it(
    "produces money_actions.status = captured and a readable audit trail entry, end to end",
    async () => {
      // 1. Create product.
      const merchant = await createTestMerchant("__checkout_e2e_merchant__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      const [product] = await db
        .insert(schema.products)
        .values({
          merchantId: merchant.id,
          name: "E2E Test Coffee",
          description: "End-to-end checkout test product.",
          status: "active",
        })
        .returning();

      const [variant] = await db
        .insert(schema.productVariants)
        .values({
          productId: product.id,
          merchantId: merchant.id,
          sku: `e2e-${Date.now()}`,
          pricePaise: 75_000,
          costPaise: 30_000,
          stock: 5,
          status: "active",
        })
        .returning();

      const [agent] = await db
        .insert(schema.agents)
        .values({ merchantId: merchant.id, name: "__checkout_e2e_agent__", apiKeyHash: `e2e_${Date.now()}`, status: "active" })
        .returning();

      const now = new Date();
      await db.insert(schema.spendCaps).values({
        agentId: agent.id,
        capPaise: 1_000_000,
        spentPaise: 0,
        perTransactionMaxPaise: 1_000_000,
        windowStart: now,
        windowEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: "active",
      });

      // 2. Checkout: a real Razorpay order created through the gate.
      const checkout = await attemptMoneyAction({
        agentId: agent.id,
        merchantId: merchant.id,
        type: "order_create",
        amountPaise: variant.pricePaise,
        context: `Checkout: ${product.name}`,
        variantId: variant.id,
      });
      expect(checkout.decision).toBe("allow");
      expect(checkout.razorpayOrderId).toMatch(/^order_/);

      const [afterCheckout] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, checkout.moneyActionId!));
      expect(afterCheckout.status).toBe("executed");

      const [variantAfterCheckout] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variant.id));
      expect(variantAfterCheckout.stock).toBe(4); // decremented atomically at checkout time

      // 3. Capture: confirmCapture is what /api/checkout/verify and the
      // webhook both converge on once a payment is verified.
      const capture = await confirmCapture(checkout.moneyActionId!, "pay_e2e_synthetic", "checkout_signature");
      expect(capture.decision).toBe("allow");

      // 4. Verify final status.
      const [afterCapture] = await db.select().from(schema.moneyActions).where(eq(schema.moneyActions.id, checkout.moneyActionId!));
      expect(afterCapture.status).toBe("captured");
      expect(afterCapture.razorpayPaymentId).toBe("pay_e2e_synthetic");
      expect(afterCapture.productId).toBe(product.id);

      // 5. Audit trail shows both the checkout and the capture.
      const trail = await getRecentAuditEntries(merchant.id, 20);
      const checkoutEntry = trail.find((e) => e.event === "money_action_executed" && e.reason.includes(product.name));
      const captureEntry = trail.find((e) => e.event === "money_action_captured");

      expect(checkoutEntry).toBeDefined();
      expect(checkoutEntry?.decision).toBe("allow");
      expect(captureEntry).toBeDefined();
      expect(captureEntry?.decision).toBe("allow");
      expect(captureEntry?.reason).toMatch(/captured/i);
    },
    20_000,
  );
});
