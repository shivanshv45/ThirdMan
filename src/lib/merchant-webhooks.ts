import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { encrypt } from "@/lib/crypto";
import { validateWebhookUrl } from "@/lib/webhooks/policy";
import { env } from "@/lib/env";
import { randomBytes } from "node:crypto";

/**
 * Dashboard-facing mutations for a merchant's registered outbound
 * webhook (/dashboard/embed's Notifications panel). Follows
 * dashboard-mutations.ts's own split: framework-agnostic logic here,
 * thin Server Action wrappers in the page's actions.ts.
 */

const VALID_EVENTS = ["order.paid", "order.held", "order.refunded", "stock.changed"] as const;
export type WebhookEventType = (typeof VALID_EVENTS)[number];

function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export interface RegisterWebhookInput {
  merchantId: string;
  url: string;
  events: string[];
}

/** Registers a new webhook, generating a fresh signing secret shown exactly once — see the schema comment on merchant_webhooks.secretEncrypted for why this one, unlike the embed publishable key, genuinely is a secret. */
export async function registerMerchantWebhook(input: RegisterWebhookInput): Promise<{ webhook: typeof schema.merchantWebhooks.$inferSelect; rawSecret: string }> {
  const urlCheck = validateWebhookUrl(input.url, { allowLocalhostHttp: env.NODE_ENV !== "production" });
  if (!urlCheck.valid) {
    throw new Error(urlCheck.reason ?? "Invalid webhook URL");
  }

  const events = input.events.filter((e): e is WebhookEventType => (VALID_EVENTS as readonly string[]).includes(e));
  if (events.length === 0) {
    throw new Error("Select at least one event to subscribe to");
  }

  const rawSecret = generateWebhookSecret();

  const [webhook] = await db
    .insert(schema.merchantWebhooks)
    .values({
      merchantId: input.merchantId,
      url: input.url,
      secretEncrypted: encrypt(rawSecret),
      subscribedEvents: events,
    })
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "merchant_webhook_registered",
    decision: "n/a",
    reason: `Merchant registered a webhook at ${new URL(input.url).hostname}, subscribed to: ${events.join(", ")}.`,
    metadata: { webhookId: webhook.id },
  });

  return { webhook, rawSecret };
}

async function requireOwnedWebhook(merchantId: string, webhookId: string) {
  const [webhook] = await db
    .select()
    .from(schema.merchantWebhooks)
    .where(and(eq(schema.merchantWebhooks.id, webhookId), eq(schema.merchantWebhooks.merchantId, merchantId)));
  if (!webhook) throw new Error("Webhook not found");
  return webhook;
}

export interface UpdateWebhookInput {
  merchantId: string;
  webhookId: string;
  url: string;
  events: string[];
}

export async function updateMerchantWebhook(input: UpdateWebhookInput) {
  await requireOwnedWebhook(input.merchantId, input.webhookId);

  const urlCheck = validateWebhookUrl(input.url, { allowLocalhostHttp: env.NODE_ENV !== "production" });
  if (!urlCheck.valid) {
    throw new Error(urlCheck.reason ?? "Invalid webhook URL");
  }

  const events = input.events.filter((e): e is WebhookEventType => (VALID_EVENTS as readonly string[]).includes(e));
  if (events.length === 0) {
    throw new Error("Select at least one event to subscribe to");
  }

  const [webhook] = await db
    .update(schema.merchantWebhooks)
    .set({ url: input.url, subscribedEvents: events, updatedAt: new Date() })
    .where(eq(schema.merchantWebhooks.id, input.webhookId))
    .returning();

  await logAuditEntry({
    merchantId: input.merchantId,
    actor: "merchant",
    event: "merchant_webhook_updated",
    decision: "n/a",
    reason: `Merchant updated their webhook (${new URL(input.url).hostname}), subscribed to: ${events.join(", ")}.`,
    metadata: { webhookId: webhook.id },
  });

  return webhook;
}

export async function setMerchantWebhookStatus(merchantId: string, webhookId: string, status: "active" | "disabled") {
  await requireOwnedWebhook(merchantId, webhookId);

  await db.update(schema.merchantWebhooks).set({ status, updatedAt: new Date() }).where(eq(schema.merchantWebhooks.id, webhookId));

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: status === "disabled" ? "merchant_webhook_disabled" : "merchant_webhook_enabled",
    decision: "n/a",
    reason: status === "disabled" ? "Merchant disabled their webhook. No further deliveries will be attempted." : "Merchant re-enabled their webhook.",
    metadata: { webhookId },
  });
}

export async function getMerchantWebhooks(merchantId: string) {
  return db.select().from(schema.merchantWebhooks).where(eq(schema.merchantWebhooks.merchantId, merchantId));
}

export async function getRecentDeliveries(merchantId: string, limit = 30) {
  return db
    .select({
      id: schema.webhookDeliveries.id,
      eventType: schema.webhookDeliveries.eventType,
      status: schema.webhookDeliveries.status,
      attemptCount: schema.webhookDeliveries.attemptCount,
      lastAttemptAt: schema.webhookDeliveries.lastAttemptAt,
      nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
      lastStatusCode: schema.webhookDeliveries.lastStatusCode,
      lastError: schema.webhookDeliveries.lastError,
      createdAt: schema.webhookDeliveries.createdAt,
      webhookUrl: schema.merchantWebhooks.url,
    })
    .from(schema.webhookDeliveries)
    .innerJoin(schema.merchantWebhooks, eq(schema.webhookDeliveries.webhookId, schema.merchantWebhooks.id))
    .where(eq(schema.webhookDeliveries.merchantId, merchantId))
    .orderBy(desc(schema.webhookDeliveries.createdAt))
    .limit(limit);
}
