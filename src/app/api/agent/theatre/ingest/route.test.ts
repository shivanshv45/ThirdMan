import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { getBuyerAgentRuns, verifyMoneyActionIds } from "@/lib/dashboard";
import { POST } from "./route";

/**
 * Layer 19-6: the run-log ingest endpoint is merchant-scoped and treats
 * its input as untrusted. Cross-merchant id enumeration must fail
 * closed (isolation.test.ts's standard), and a run log containing a
 * fabricated money action id must not let the theatre view (dashboard.ts's
 * verifyMoneyActionIds) assert anything about money that didn't happen —
 * the read-side check must independently confirm the id is real.
 */

function ingestRequest(body: object, rawKey: string | null) {
  return new NextRequest("http://localhost/api/agent/theatre/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...(rawKey ? { authorization: `Bearer ${rawKey}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/theatre/ingest", () => {
  let merchantId: string | undefined;
  let agentId: string | undefined;

  afterEach(async () => {
    if (!merchantId) return;
    const currentMerchantId = merchantId;
    const currentAgentId = agentId!;
    merchantId = undefined;
    agentId = undefined;

    await db.delete(schema.buyerAgentRuns).where(eq(schema.buyerAgentRuns.merchantId, currentMerchantId));
    await db.delete(schema.agents).where(eq(schema.agents.id, currentAgentId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, currentMerchantId));
  });

  async function makeMerchantAndAgent() {
    const [merchant] = await db
      .insert(schema.merchants)
      .values({
        name: `__theatre_ingest_test_${Date.now()}_${Math.random()}__`,
        email: `theatre_ingest_${Date.now()}_${Math.random()}@test.invalid`,
        passwordHash: "test:not-a-real-hash",
      })
      .returning();
    const rawKey = generateApiKey();
    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__theatre_ingest_test_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
      .returning();
    return { merchant, agent, rawKey };
  }

  it("rejects a request with no Authorization header, 401", async () => {
    const res = await POST(ingestRequest({ runId: "x", rawLog: "{}" }, null));
    expect(res.status).toBe(401);
  });

  it("rejects a request over the size ceiling, 400", async () => {
    const { merchant, agent, rawKey } = await makeMerchantAndAgent();
    merchantId = merchant.id;
    agentId = agent.id;

    const res = await POST(ingestRequest({ runId: "x", rawLog: "a".repeat(3_000_000) }, rawKey));
    expect(res.status).toBe(400);
  });

  it("stores the raw log verbatim, scoped to the calling agent's own merchant", async () => {
    const { merchant, agent, rawKey } = await makeMerchantAndAgent();
    merchantId = merchant.id;
    agentId = agent.id;

    const rawLog = JSON.stringify({ type: "run_started", stepIndex: -1, timestamp: new Date().toISOString(), message: "test goal" }) + "\n";
    const res = await POST(ingestRequest({ runId: "test-run-1", rawLog }, rawKey));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const runs = await getBuyerAgentRuns(merchant.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("test-run-1");
    expect(runs[0].agentId).toBe(agent.id);
  });

  it("re-ingesting the same runId updates the existing row rather than duplicating it", async () => {
    const { merchant, agent, rawKey } = await makeMerchantAndAgent();
    merchantId = merchant.id;
    agentId = agent.id;

    await POST(ingestRequest({ runId: "test-run-2", rawLog: "{}" }, rawKey));
    const second = await POST(ingestRequest({ runId: "test-run-2", rawLog: JSON.stringify({ type: "run_ended", stepIndex: 0, timestamp: new Date().toISOString(), outcome: "succeeded" }) }, rawKey));
    expect((await second.json()).updated).toBe(true);

    const runs = await getBuyerAgentRuns(merchant.id);
    expect(runs.filter((r) => r.runId === "test-run-2")).toHaveLength(1);
  });

  it("a fabricated money action id in the log is not confirmed as real by verifyMoneyActionIds — the theatre view cannot assert money that didn't happen", async () => {
    const { merchant, agent, rawKey } = await makeMerchantAndAgent();
    merchantId = merchant.id;
    agentId = agent.id;

    const fabricatedId = "00000000-0000-0000-0000-000000000000";
    const rawLog = JSON.stringify({ type: "tool_result", stepIndex: 0, timestamp: new Date().toISOString(), toolName: "purchase", moneyActionId: fabricatedId }) + "\n";
    await POST(ingestRequest({ runId: "test-run-fabricated", rawLog }, rawKey));

    const verified = await verifyMoneyActionIds(merchant.id, [fabricatedId]);
    expect(verified.has(fabricatedId)).toBe(false);
  });

  it("a cross-merchant real money action id is not confirmed — verifyMoneyActionIds is scoped to the calling merchant, not global by id", async () => {
    const { merchant, agent } = await makeMerchantAndAgent();
    merchantId = merchant.id;
    agentId = agent.id;

    // A second, unrelated merchant with a real money action — an
    // untrusted run log that happened to guess/reuse a real id from
    // another merchant's records must not be confirmed as belonging to
    // this merchant's own theatre view.
    const [otherMerchant] = await db
      .insert(schema.merchants)
      .values({ name: `__theatre_ingest_other_${Date.now()}__`, email: `theatre_other_${Date.now()}@test.invalid`, passwordHash: "test:not-a-real-hash" })
      .returning();
    const [otherAgent] = await db
      .insert(schema.agents)
      .values({ merchantId: otherMerchant.id, name: "__other_agent__", apiKeyHash: `other_${Date.now()}`, status: "active" })
      .returning();
    const [otherAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: otherMerchant.id, agentId: otherAgent.id, type: "order_create", amountPaise: 1000, status: "allowed" })
      .returning();

    try {
      const verified = await verifyMoneyActionIds(merchant.id, [otherAction.id]);
      expect(verified.has(otherAction.id)).toBe(false);
    } finally {
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.id, otherAction.id));
      await db.delete(schema.agents).where(eq(schema.agents.id, otherAgent.id));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, otherMerchant.id));
    }
  });
});
