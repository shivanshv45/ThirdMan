import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { logAuditEntry } from "@/lib/audit";
import { env } from "@/lib/env";
import { hasExhaustedRetries, isRetryableOutcome, nextDeliveryAttemptTime, validateWebhookUrl } from "./policy";

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Signs the exact payload bytes with HMAC-SHA256, the same discipline
 * webhook-verify.ts's own docstring establishes for INBOUND Razorpay
 * signatures: serialize once, sign that exact string, send that exact
 * string. Never JSON.stringify twice — the signature only matches the
 * bytes it was actually computed over.
 */
function signPayload(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Attempts one delivery for one due row. Never throws — every outcome (success, retryable failure, exhaustion) is recorded on the row and, on exhaustion, in the audit log. */
export async function attemptDelivery(deliveryId: string): Promise<void> {
  const [delivery] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId));
  if (!delivery || delivery.status !== "pending") return;

  const [webhook] = await db.select().from(schema.merchantWebhooks).where(eq(schema.merchantWebhooks.id, delivery.webhookId));
  if (!webhook || webhook.status !== "active") {
    await db
      .update(schema.webhookDeliveries)
      .set({ status: "failed", lastError: "Webhook was disabled or deleted before delivery.", nextAttemptAt: null })
      .where(eq(schema.webhookDeliveries.id, deliveryId));
    return;
  }

  const attemptNumber = delivery.attemptCount + 1;
  const now = new Date();
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000).toString();

  let statusCode: number | null = null;
  let errorMessage: string | null = null;

  const urlCheck = validateWebhookUrl(webhook.url, { allowLocalhostHttp: env.NODE_ENV !== "production" });
  if (!urlCheck.valid) {
    // The URL was valid when saved but production config or DNS
    // behaviour can change — re-validate on every send, not just at
    // save time (see policy.ts's docstring).
    await finalizeExhausted(deliveryId, delivery.merchantId, webhook.url, `URL no longer valid: ${urlCheck.reason}`);
    return;
  }

  try {
    const secret = decrypt(webhook.secretEncrypted);
    const signature = signPayload(rawBody, timestamp, secret);

    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ThirdMan-Signature": signature,
        "X-ThirdMan-Timestamp": timestamp,
        "X-ThirdMan-Event": delivery.eventType,
      },
      body: rawBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    statusCode = res.status;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    await db
      .update(schema.webhookDeliveries)
      .set({ status: "delivered", attemptCount: attemptNumber, lastAttemptAt: now, lastStatusCode: statusCode, nextAttemptAt: null })
      .where(eq(schema.webhookDeliveries.id, deliveryId));
    return;
  }

  const retryable = isRetryableOutcome(statusCode);
  const lastError = errorMessage ?? `Received HTTP ${statusCode}`;

  if (!retryable || hasExhaustedRetries(attemptNumber)) {
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: retryable ? "exhausted" : "failed",
        attemptCount: attemptNumber,
        lastAttemptAt: now,
        lastStatusCode: statusCode,
        lastError,
        nextAttemptAt: null,
      })
      .where(eq(schema.webhookDeliveries.id, deliveryId));

    // A stop is a recorded outcome, not a silent return — same
    // discipline as the recovery pipeline's own stopping rules (see
    // ARCHITECTURE.md's recovery pipeline contract, point 5).
    await logAuditEntry({
      merchantId: delivery.merchantId,
      actor: "system",
      event: retryable ? "webhook_delivery_exhausted" : "webhook_delivery_rejected",
      decision: "deny",
      reason: retryable
        ? `Gave up delivering "${delivery.eventType}" to ${new URL(webhook.url).hostname} after ${attemptNumber} attempts (last error: ${lastError}).`
        : `"${delivery.eventType}" delivery to ${new URL(webhook.url).hostname} was rejected (HTTP ${statusCode}) and will not be retried.`,
      boundApplied: `webhook_max_attempts:${attemptNumber}/${attemptNumber}`,
      metadata: { deliveryId, webhookId: webhook.id, statusCode },
    });
    return;
  }

  await db
    .update(schema.webhookDeliveries)
    .set({
      attemptCount: attemptNumber,
      lastAttemptAt: now,
      lastStatusCode: statusCode,
      lastError,
      nextAttemptAt: nextDeliveryAttemptTime(attemptNumber, now),
    })
    .where(eq(schema.webhookDeliveries.id, deliveryId));
}

async function finalizeExhausted(deliveryId: string, merchantId: string, url: string, reason: string): Promise<void> {
  await db
    .update(schema.webhookDeliveries)
    .set({ status: "failed", lastError: reason, nextAttemptAt: null })
    .where(eq(schema.webhookDeliveries.id, deliveryId));

  await logAuditEntry({
    merchantId,
    actor: "system",
    event: "webhook_delivery_rejected",
    decision: "deny",
    reason: `"${url}" is no longer a deliverable webhook URL: ${reason}`,
    metadata: { deliveryId },
  });
}
