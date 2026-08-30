import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { createTestMerchant } from "@/lib/test-helpers";
import { POST } from "./route";
import { GET } from "./[requestId]/route";

/**
 * L22-7: cross-merchant isolation by id enumeration on the agent-facing
 * REST surface, and the "denial is HTTP 200, unauthenticated is 401"
 * shape every other agent route already follows.
 */

function openRequest(body: unknown, apiKey?: string) {
  return new NextRequest("http://localhost/api/agent/returns", {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
}

function statusRequest(apiKey?: string) {
  return new NextRequest("http://localhost/api/agent/returns/x", {
    method: "GET",
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
}

async function makeAgentWithCapability(merchantId: string) {
  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId, name: "__returns_route_test_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();
  await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "purchase:create" });
  return { agent, rawKey };
}

async function makeCapturedMoneyAction(merchantId: string, agentId: string) {
  const [row] = await db
    .insert(schema.moneyActions)
    .values({
      merchantId,
      agentId,
      type: "order_create",
      amountPaise: 50_000,
      status: "captured",
      razorpayEntityId: `order_returns_route_test_${Date.now()}_${Math.random()}`,
      razorpayPaymentId: `pay_returns_route_test_${Date.now()}_${Math.random()}`,
    })
    .returning();
  return row;
}

describe("POST /api/agent/returns", () => {
  const merchantIds: string[] = [];

  afterEach(async () => {
    const ids = [...merchantIds];
    merchantIds.length = 0;
    for (const merchantId of ids) {
      const requestIds = await db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.merchantId, merchantId));
      for (const r of requestIds) {
        await db.delete(schema.returnRequestMessages).where(eq(schema.returnRequestMessages.returnRequestId, r.id));
      }
      await db.delete(schema.returnRequests).where(eq(schema.returnRequests.merchantId, merchantId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
      await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
      const agentIds = (await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId))).map((a) => a.id);
      if (agentIds.length > 0) {
        await db.delete(schema.agentCapabilities).where(inArray(schema.agentCapabilities.agentId, agentIds));
      }
      await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("401s with no bearer key", async () => {
    const res = await POST(openRequest({ moneyActionId: "00000000-0000-0000-0000-000000000000", reason: "test" }));
    expect(res.status).toBe(401);
  });

  it("refuses (200, not a refund) a real purchase belonging to a DIFFERENT agent", async () => {
    const merchantA = await createTestMerchant("__returns_route_A__");
    merchantIds.push(merchantA.id);
    const { rawKey: keyA } = await makeAgentWithCapability(merchantA.id);
    const { agent: agentB } = await makeAgentWithCapability(merchantA.id);
    const actionOwnedByB = await makeCapturedMoneyAction(merchantA.id, agentB.id);

    const res = await POST(openRequest({ moneyActionId: actionOwnedByB.id, reason: "not mine but trying" }, keyA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("refused");
    expect(body.requestId).toBeNull();
  });

  it("opens a real request for the agent's own purchase, then GET returns its status scoped to that agent only", async () => {
    const merchant = await createTestMerchant("__returns_route_ownpurchase__");
    merchantIds.push(merchant.id);
    const { agent, rawKey } = await makeAgentWithCapability(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, agent.id);

    const openRes = await POST(openRequest({ moneyActionId: action.id, reason: "arrived broken" }, rawKey));
    const openBody = await openRes.json();
    expect(openBody.status).toBe("awaiting_merchant");
    expect(openBody.requestId).toBeTruthy();

    const statusRes = await GET(statusRequest(rawKey), { params: Promise.resolve({ requestId: openBody.requestId }) });
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe("awaiting_merchant");
  });

  it("a DIFFERENT agent (even same merchant) cannot read another agent's return request status", async () => {
    const merchant = await createTestMerchant("__returns_route_statusisolation__");
    merchantIds.push(merchant.id);
    const { agent: owner, rawKey: ownerKey } = await makeAgentWithCapability(merchant.id);
    const { rawKey: imposterKey } = await makeAgentWithCapability(merchant.id);
    const action = await makeCapturedMoneyAction(merchant.id, owner.id);

    const openRes = await POST(openRequest({ moneyActionId: action.id, reason: "reason" }, ownerKey));
    const openBody = await openRes.json();

    const statusRes = await GET(statusRequest(imposterKey), { params: Promise.resolve({ requestId: openBody.requestId }) });
    expect(statusRes.status).toBe(404);
  });
});
