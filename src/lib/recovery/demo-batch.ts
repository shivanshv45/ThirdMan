import { eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { recordPaymentFailure } from "@/lib/recovery/intake";

/**
 * A merchant-visible, explicitly labelled demo batch — not a hidden
 * background job. There is no checkout in this codebase yet (Layer 4),
 * so there is no organic supply of failed payments to recover; this is
 * the deliberate substitute. Every row it writes has source: "simulated"
 * and is badged as such in the UI. See plans/layer-3-recovery-pipeline.md,
 * "The one thing to get right before writing code."
 *
 * Spans a deliberate mix of decline categories and amounts so the policy
 * in policy.ts actually branches differently per row, rather than every
 * row hitting the same rule.
 */
const DEMO_FAILURES = [
  {
    declineCode: "GATEWAY_TIMEOUT_ERROR",
    declineDescription: "The request timed out at the gateway.",
    amountPaise: 45000,
  },
  {
    declineCode: "BAD_REQUEST_ERROR",
    declineDescription: "Payment failed due to insufficient funds in the customer account.",
    amountPaise: 120000,
  },
  {
    declineCode: "GATEWAY_ERROR",
    declineDescription: "Card declined by the issuing bank.",
    amountPaise: 89900,
  },
  {
    declineCode: "GATEWAY_ERROR",
    declineDescription: "Card declined by the issuing bank.",
    amountPaise: 350000,
  },
  {
    declineCode: "BAD_REQUEST_ERROR",
    declineDescription: "The card has expired.",
    amountPaise: 67500,
  },
  {
    declineCode: "BAD_REQUEST_ERROR",
    declineDescription: "The card number is invalid.",
    amountPaise: 15000,
  },
  {
    declineCode: "BAD_REQUEST_ERROR",
    declineDescription: "The card has been reported lost or stolen.",
    amountPaise: 250000,
  },
  {
    declineCode: "GATEWAY_TIMEOUT_ERROR",
    declineDescription: "The request timed out at the gateway.",
    amountPaise: 1800, // below MIN_RECOVERABLE_AMOUNT_PAISE — ROI governor should refuse this one
  },
  {
    declineCode: "GATEWAY_ERROR",
    declineDescription: "Card declined by the issuing bank.",
    amountPaise: 850000, // above HIGH_VALUE_ESCALATION_PAISE — should route to a human
  },
];

/**
 * Loads (or reloads) the calling merchant's demo failure batch. Idempotent
 * in the sense that matters for repeated filming: it clears the merchant's
 * previously-simulated, not-yet-recovered rows first rather than stacking
 * duplicates on every click. Rows already mid-recovery or resolved are
 * left alone so re-clicking mid-demo doesn't erase real progress.
 */
export async function loadDemoFailureBatch(merchantId: string): Promise<number> {
  await db
    .delete(schema.paymentFailures)
    .where(
      and(
        eq(schema.paymentFailures.merchantId, merchantId),
        eq(schema.paymentFailures.source, "simulated"),
        eq(schema.paymentFailures.status, "new"),
      ),
    );

  const now = new Date();
  for (const failure of DEMO_FAILURES) {
    await recordPaymentFailure({
      merchantId,
      amountPaise: failure.amountPaise,
      declineCode: failure.declineCode,
      declineDescription: failure.declineDescription,
      source: "simulated",
      failedAt: now,
    });
  }

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "demo_failure_batch_loaded",
    decision: "n/a",
    reason: `Loaded a demo batch of ${DEMO_FAILURES.length} simulated failed payments for the recovery pipeline. These are labelled and displayed as simulated — no real payment failed. Everything downstream (diagnosis, policy, recovery attempts) is real.`,
  });

  return DEMO_FAILURES.length;
}
