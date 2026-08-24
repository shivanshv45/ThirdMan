import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { runRecoveryForFailure, runRecoveryBatch, confirmRecoveryLinkPaid } from "@/lib/recovery/sequencer";
import { createTestMerchant } from "@/lib/test-helpers";

/**
 * No mocks — real DB, real gate, real Razorpay test-mode calls where a
 * strategy actually moves money. Same discipline as gate.test.ts.
 *
 * Cleanup is scoped to each test's own merchant id, deleted in FK
 * dependency order (recovery_attempts -> payment_failures, and the
 * agents/spend_caps the recovery pipeline lazily provisions per
 * merchant), matching the lesson in FAILURES.md about unscoped deletes
 * racing other concurrently-running test files.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    // recovery_attempts.money_action_id FKs into money_actions, so it
    // must be cleared before money_actions — same FK-dependency-order
    // lesson FAILURES.md already documents for audit_log/money_actions.
    const failures = await db
      .select({ id: schema.paymentFailures.id })
      .from(schema.paymentFailures)
      .where(eq(schema.paymentFailures.merchantId, merchantId));
    const failureIds = failures.map((f) => f.id);
    if (failureIds.length > 0) {
      await db.delete(schema.recoveryAttempts).where(inArray(schema.recoveryAttempts.paymentFailureId, failureIds));
    }
    await db.delete(schema.paymentFailures).where(eq(schema.paymentFailures.merchantId, merchantId));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));

    const agents = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length > 0) {
      await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIds));
    }
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function makeFailure(merchantId: string, overrides: Partial<typeof schema.paymentFailures.$inferInsert> = {}) {
  const [failure] = await db
    .insert(schema.paymentFailures)
    .values({
      merchantId,
      amountPaise: 500000,
      declineCode: "GATEWAY_ERROR",
      declineDescription: "Card declined by the issuing bank.",
      source: "simulated",
      status: "new",
      failedAt: new Date(),
      ...overrides,
    })
    .returning();
  return failure;
}

describe("runRecoveryForFailure — merchant isolation", () => {
  it("refuses to act on another merchant's failure id, by id enumeration", async () => {
    const merchantA = await createTestMerchant("__recovery_iso_a__", { withRazorpayCredentials: true });
    const merchantB = await createTestMerchant("__recovery_iso_b__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchantA.id, merchantB.id);

    const failureA = await makeFailure(merchantA.id);

    await expect(runRecoveryForFailure(merchantB.id, failureA.id)).rejects.toThrow(/not found/i);
  });
});

describe("runRecoveryForFailure — stopping and outcome recording", () => {
  it("a failure diagnosed unrecoverable is written off with zero recovered", async () => {
    const merchant = await createTestMerchant("__recovery_unrecoverable__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchant.id);

    const failure = await makeFailure(merchant.id, {
      declineCode: "BAD_REQUEST_ERROR",
      declineDescription: "The card has been reported lost or stolen.",
      amountPaise: 200000,
    });

    const outcome = await runRecoveryForFailure(merchant.id, failure.id);
    expect(outcome.proceeded).toBe(false);
    expect(outcome.recoveredPaise).toBe(0);

    const [updated] = await db.select().from(schema.paymentFailures).where(eq(schema.paymentFailures.id, failure.id));
    expect(updated.status).toBe("written_off");
  });

  it("a failure already recovered is not attempted again", async () => {
    const merchant = await createTestMerchant("__recovery_already_done__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchant.id);

    const failure = await makeFailure(merchant.id, { status: "recovered" });

    const outcome = await runRecoveryForFailure(merchant.id, failure.id);
    expect(outcome.proceeded).toBe(false);
    expect(outcome.recoveredPaise).toBe(0);

    const attempts = await db
      .select()
      .from(schema.recoveryAttempts)
      .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));
    expect(attempts.length).toBe(0);
  });

  it("a high-value failure routes to human_escalation and moves no money", async () => {
    const merchant = await createTestMerchant("__recovery_high_value__", { withRazorpayCredentials: true });
    createdMerchantIds.push(merchant.id);

    const failure = await makeFailure(merchant.id, {
      declineCode: "GATEWAY_ERROR",
      declineDescription: "Card declined by the issuing bank.",
      amountPaise: 900000, // above HIGH_VALUE_ESCALATION_PAISE
    });

    const outcome = await runRecoveryForFailure(merchant.id, failure.id);
    expect(outcome.proceeded).toBe(false);
    expect(outcome.stoppingRule).toBe("high_value_requires_human");
    expect(outcome.recoveredPaise).toBe(0);
  });

  it(
    "recoveredPaise is 0 on every non-succeeded attempt outcome",
    async () => {
      // Makes a real gate call (technical_failure maps to
      // retry_same_instrument, a money-moving strategy).
      const merchant = await createTestMerchant("__recovery_zero_check__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      const failure = await makeFailure(merchant.id, {
        declineCode: "GATEWAY_TIMEOUT_ERROR",
        declineDescription: "The request timed out.",
        amountPaise: 300000,
      });

      await runRecoveryForFailure(merchant.id, failure.id);

      const attempts = await db
        .select()
        .from(schema.recoveryAttempts)
        .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));

      for (const attempt of attempts) {
        if (attempt.outcome !== "succeeded") {
          expect(attempt.recoveredPaise).toBe(0);
        }
      }
    },
    20000,
  );

  it(
    "a real money-moving attempt creates a genuine Razorpay order through the gate, denied if the cap is exhausted",
    async () => {
      const merchant = await createTestMerchant("__recovery_cap_denied__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      const failure = await makeFailure(merchant.id, {
        declineCode: "BAD_REQUEST_ERROR",
        declineDescription: "Payment failed due to insufficient funds in the customer account.",
        amountPaise: 300000, // below HIGH_VALUE_ESCALATION_PAISE so the policy actually proceeds
      });

      // First run lazily provisions the recovery agent + a generous cap
      // and succeeds in reaching the gate (the order itself won't be
      // paid, so this attempt records as failed — see sequencer.ts on why
      // an order created is not money recovered). What this test proves
      // is that a cap-exhausted recovery attempt is a normal recorded
      // outcome, not a crash — so exhaust the cap directly afterward and
      // confirm the next attempt is denied cleanly.
      await runRecoveryForFailure(merchant.id, failure.id);

      const [recoveryAgent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.merchantId, merchant.id));
      expect(recoveryAgent).toBeDefined();

      await db
        .update(schema.spendCaps)
        .set({ spentPaise: schema.spendCaps.capPaise })
        .where(eq(schema.spendCaps.agentId, recoveryAgent.id));

      const failure2 = await makeFailure(merchant.id, {
        declineCode: "BAD_REQUEST_ERROR",
        declineDescription: "Payment failed due to insufficient funds in the customer account.",
        amountPaise: 300000,
      });

      const outcome = await runRecoveryForFailure(merchant.id, failure2.id);
      expect(outcome.proceeded).toBe(true);
      expect(outcome.outcome).toBe("failed");
      expect(outcome.recoveredPaise).toBe(0);
      expect(outcome.reason.toLowerCase()).toContain("denied");
    },
    30000,
  );
});

describe("runRecoveryForFailure — real Payment Link (Layer 4-3)", () => {
  it(
    "a money-moving attempt creates a real, payable Razorpay Payment Link, recorded as pending (not failed) since it's paid asynchronously",
    async () => {
      const merchant = await createTestMerchant("__recovery_link_test__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      const failure = await makeFailure(merchant.id, {
        declineCode: "GATEWAY_TIMEOUT_ERROR",
        declineDescription: "The request timed out.",
        amountPaise: 300000,
      });

      const outcome = await runRecoveryForFailure(merchant.id, failure.id);
      expect(outcome.proceeded).toBe(true);
      expect(outcome.outcome).toBe("pending");
      expect(outcome.recoveredPaise).toBe(0);
      expect(outcome.reason).toMatch(/real, payable link/i);

      const [attempt] = await db
        .select()
        .from(schema.recoveryAttempts)
        .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));
      expect(attempt.outcome).toBe("pending");
      expect(attempt.razorpayPaymentLinkId).toMatch(/^plink_/);
      expect(attempt.paymentLinkUrl).toMatch(/^https:\/\//);
    },
    20000,
  );

  it(
    "confirmRecoveryLinkPaid sets recoveredPaise from the verified webhook amount and marks the failure recovered",
    async () => {
      const merchant = await createTestMerchant("__recovery_link_paid_test__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      const failure = await makeFailure(merchant.id, {
        declineCode: "GATEWAY_TIMEOUT_ERROR",
        declineDescription: "The request timed out.",
        amountPaise: 300000,
      });

      await runRecoveryForFailure(merchant.id, failure.id);
      const [attempt] = await db
        .select()
        .from(schema.recoveryAttempts)
        .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));
      expect(attempt.razorpayPaymentLinkId).toBeTruthy();

      await confirmRecoveryLinkPaid(attempt.razorpayPaymentLinkId!, 300000);

      const [updatedAttempt] = await db.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.id, attempt.id));
      expect(updatedAttempt.outcome).toBe("succeeded");
      expect(updatedAttempt.recoveredPaise).toBe(300000);

      const [updatedFailure] = await db.select().from(schema.paymentFailures).where(eq(schema.paymentFailures.id, failure.id));
      expect(updatedFailure.status).toBe("recovered");
    },
    20000,
  );

  it(
    "confirmRecoveryLinkPaid is idempotent: a redelivered webhook does not double-count recoveredPaise",
    async () => {
      const merchant = await createTestMerchant("__recovery_link_paid_idempotent__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      const failure = await makeFailure(merchant.id, {
        declineCode: "GATEWAY_TIMEOUT_ERROR",
        declineDescription: "The request timed out.",
        amountPaise: 250000,
      });

      await runRecoveryForFailure(merchant.id, failure.id);
      const [attempt] = await db
        .select()
        .from(schema.recoveryAttempts)
        .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));

      await confirmRecoveryLinkPaid(attempt.razorpayPaymentLinkId!, 250000);
      await confirmRecoveryLinkPaid(attempt.razorpayPaymentLinkId!, 250000);

      const [updatedAttempt] = await db.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.id, attempt.id));
      expect(updatedAttempt.recoveredPaise).toBe(250000);
    },
    20000,
  );

  it("confirmRecoveryLinkPaid on an unknown link id is a safe no-op, not a crash", async () => {
    await expect(confirmRecoveryLinkPaid("plink_does_not_exist", 100000)).resolves.toBeUndefined();
  });
});

describe("runRecoveryBatch — idempotency across re-runs", () => {
  it(
    "re-running a batch does not double count an already-resolved failure",
    async () => {
      const merchant = await createTestMerchant("__recovery_batch_idempotent__", { withRazorpayCredentials: true });
      createdMerchantIds.push(merchant.id);

      await makeFailure(merchant.id, {
        declineCode: "BAD_REQUEST_ERROR",
        declineDescription: "The card has been reported lost or stolen.",
        amountPaise: 400000,
      });

      const first = await runRecoveryBatch(merchant.id);
      expect(first.writtenOff).toBe(1);

      const second = await runRecoveryBatch(merchant.id);
      // The failure is now written_off, so the second batch run finds
      // nothing pending to act on at all.
      expect(second.attempted).toBe(0);
      expect(second.writtenOff).toBe(0);
    },
    20000,
  );
});
