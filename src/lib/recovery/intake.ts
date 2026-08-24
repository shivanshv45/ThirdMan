import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export interface RecordPaymentFailureInput {
  merchantId: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  amountPaise: number;
  declineCode: string;
  declineDescription?: string;
  customerRef?: string;
  source: (typeof schema.paymentFailureSourceEnum.enumValues)[number];
  failedAt: Date;
}

/**
 * The single writer both the webhook (source: "webhook") and the merchant's
 * demo batch loader (source: "simulated") go through. Everything downstream
 * of this insert — diagnosis, policy, sequencing, attribution — reads
 * payment_failures without caring which caller wrote the row, which is
 * what makes the simulated batch a real exercise of the same pipeline a
 * live decline would hit.
 *
 * A repeat delivery of the same (merchantId, razorpayPaymentId) is caught
 * by the partial unique index — Razorpay redelivers webhooks, and a
 * redelivery must not double-count recovered revenue. On conflict, the
 * existing row is returned rather than throwing.
 */
export async function recordPaymentFailure(
  input: RecordPaymentFailureInput,
): Promise<typeof schema.paymentFailures.$inferSelect> {
  if (!input.razorpayPaymentId) {
    const [row] = await db.insert(schema.paymentFailures).values(input).returning();
    return row;
  }

  const [inserted] = await db
    .insert(schema.paymentFailures)
    .values(input)
    .onConflictDoNothing({
      target: [schema.paymentFailures.merchantId, schema.paymentFailures.razorpayPaymentId],
    })
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(schema.paymentFailures)
    .where(
      and(
        eq(schema.paymentFailures.merchantId, input.merchantId),
        eq(schema.paymentFailures.razorpayPaymentId, input.razorpayPaymentId),
      ),
    );

  if (!existing) {
    throw new Error("recordPaymentFailure: insert conflicted but no existing row found");
  }
  return existing;
}
