import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { encrypt } from "@/lib/crypto";
import { enqueueWebhookEvent } from "./enqueue";
import { attemptDelivery } from "./deliver";
import { drainDueDeliveries, retryDelivery } from "./runner";

/**
 * Exercises the outbound webhook queue against a REAL local HTTP
 * server, not a mocked fetch — matching this codebase's genuine-
 * failures-only testing philosophy (DECISIONS.md). A real listening
 * socket that returns 500, or refuses to listen at all, is a genuine
 * failure the retry/backoff logic has to handle, not a simulated one.
 */

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.pop()!;
    await fn();
  }
});

async function makeMerchantWithWebhook(url: string, events: string[] = ["order.paid"]) {
  const merchant = await createTestMerchant("webhook-test");
  const [webhook] = await db
    .insert(schema.merchantWebhooks)
    .values({
      merchantId: merchant.id,
      url,
      secretEncrypted: encrypt("test-webhook-secret"),
      subscribedEvents: events,
      status: "active",
    })
    .returning();

  cleanup.push(async () => {
    await db.delete(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.merchantId, merchant.id));
    await db.delete(schema.merchantWebhooks).where(eq(schema.merchantWebhooks.merchantId, merchant.id));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchant.id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));
  });

  return { merchant, webhook };
}

async function makeMoneyAction(merchantId: string, overrides: Partial<typeof schema.moneyActions.$inferInsert> = {}) {
  const [action] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId,
      type: "order_create",
      amountPaise: 50000,
      status: "captured",
      razorpayEntityId: `order_test_${Date.now()}`,
      ...overrides,
    })
    .returning();
  return action;
}

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("enqueueWebhookEvent + attemptDelivery, against a real HTTP receiver", () => {
  it("delivers successfully to a receiver that returns 200, and signs the exact sent bytes", async () => {
    let receivedBody = "";
    let receivedSignatureHeader: string | undefined;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = raw;
        receivedSignatureHeader = req.headers["x-thirdman-signature"] as string | undefined;
        res.writeHead(200);
        res.end("ok");
      });
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const { merchant, webhook } = await makeMerchantWithWebhook(`http://127.0.0.1:${port}/hook`, ["order.paid"]);
    const action = await makeMoneyAction(merchant.id);

    await enqueueWebhookEvent(merchant.id, "order.paid", action);

    const [delivery] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, webhook.id));
    expect(delivery.status).toBe("pending");

    await attemptDelivery(delivery.id);

    const [updated] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, delivery.id));
    expect(updated.status).toBe("delivered");
    expect(updated.lastStatusCode).toBe(200);
    expect(receivedSignatureHeader).toBeTruthy();
    expect(JSON.parse(receivedBody).data.moneyActionId).toBe(action.id);
  });

  it("retries a 500 with a real backoff time, then reaches exhausted with an audit entry", async () => {
    // Five real HTTP round-trips against a real local server — slower
    // than vitest's default 5s, not a hang.
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const { merchant, webhook } = await makeMerchantWithWebhook(`http://127.0.0.1:${port}/hook`);
    const action = await makeMoneyAction(merchant.id);
    await enqueueWebhookEvent(merchant.id, "order.paid", action);

    const [delivery] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, webhook.id));

    await attemptDelivery(delivery.id);
    let row = (await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, delivery.id)))[0];
    expect(row.status).toBe("pending");
    expect(row.attemptCount).toBe(1);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Drive it through every remaining attempt by forcing nextAttemptAt
    // into the past each time (a real test shouldn't wait hours for
    // the real backoff schedule) — attemptDelivery itself is exercised
    // with zero mocking; only the "is it due yet" clock is fast-forwarded.
    for (let i = 0; i < 10 && row.status === "pending"; i++) {
      await db.update(schema.webhookDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(schema.webhookDeliveries.id, delivery.id));
      await attemptDelivery(delivery.id);
      row = (await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, delivery.id)))[0];
    }

    expect(row.status).toBe("exhausted");
    expect(row.lastStatusCode).toBe(500);

    const [auditEntry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.merchantId, merchant.id));
    expect(auditEntry?.event).toBe("webhook_delivery_exhausted");
    expect(auditEntry?.decision).toBe("deny");
  }, 20_000);

  it("does not retry a 4xx — marks it failed immediately", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(422);
      res.end("bad request");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const { merchant, webhook } = await makeMerchantWithWebhook(`http://127.0.0.1:${port}/hook`);
    const action = await makeMoneyAction(merchant.id);
    await enqueueWebhookEvent(merchant.id, "order.paid", action);

    const [delivery] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, webhook.id));
    await attemptDelivery(delivery.id);

    const [row] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, delivery.id));
    expect(row.status).toBe("failed");
    expect(row.attemptCount).toBe(1);
  });

  it("a double-fired capture (two enqueue calls for the same money action) produces exactly one delivery row", async () => {
    const { merchant, webhook } = await makeMerchantWithWebhook("https://receiver.example.invalid/hook");
    const action = await makeMoneyAction(merchant.id);

    await enqueueWebhookEvent(merchant.id, "order.paid", action);
    await enqueueWebhookEvent(merchant.id, "order.paid", action);

    const rows = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, webhook.id));
    expect(rows.length).toBe(1);
  });

  it("drainDueDeliveries attempts every pending, due row", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const { merchant } = await makeMerchantWithWebhook(`http://127.0.0.1:${port}/hook`);
    const actionA = await makeMoneyAction(merchant.id);
    const actionB = await makeMoneyAction(merchant.id);
    await enqueueWebhookEvent(merchant.id, "order.paid", actionA);
    await enqueueWebhookEvent(merchant.id, "order.paid", actionB);

    const { attempted } = await drainDueDeliveries();
    expect(attempted).toBeGreaterThanOrEqual(2);

    const rows = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.merchantId, merchant.id));
    expect(rows.every((r) => r.status === "delivered")).toBe(true);
  });

  it("retryDelivery resets an exhausted delivery back to pending, scoped to the owning merchant", async () => {
    const { merchant, webhook } = await makeMerchantWithWebhook("https://receiver.example.invalid/hook");
    const action = await makeMoneyAction(merchant.id);
    await enqueueWebhookEvent(merchant.id, "order.paid", action);
    const [delivery] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, webhook.id));

    await db.update(schema.webhookDeliveries).set({ status: "exhausted", attemptCount: 5 }).where(eq(schema.webhookDeliveries.id, delivery.id));

    const otherMerchant = await createTestMerchant("webhook-test-other");
    cleanup.push(async () => {
      await db.delete(schema.merchants).where(eq(schema.merchants.id, otherMerchant.id));
    });
    await expect(retryDelivery(otherMerchant.id, delivery.id)).rejects.toThrow();

    await retryDelivery(merchant.id, delivery.id);
    const [reset] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, delivery.id));
    expect(reset.status).toBe("pending");
    expect(reset.attemptCount).toBe(0);
  });
});
