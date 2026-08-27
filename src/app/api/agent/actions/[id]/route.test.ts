import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { logAuditEntry } from "@/lib/audit";
import { GET } from "./route";

/**
 * L7-5's "why was I denied?" extension to GET /api/agent/actions/[id].
 * A denial that happens INSIDE checkBounds (no spend cap, out of stock,
 * price mismatch, ...) never creates a money_actions row at all —
 * verified against gate.ts directly, that's real, existing behaviour,
 * not a gap this test works around — so there's nothing for this route
 * to look up in that case, and it already correctly 404s. The "why"
 * section only has something to show for a decision that DID reserve
 * budget first: a post-reservation deny, an escalation, or (once
 * resolved) an approved/rejected escalation. Fixtures here insert the
 * money_actions + audit_log rows directly rather than driving a live
 * risk-layer escalation, matching isolation.test.ts's own reasoning:
 * this is about the read path and ownership scoping, not risk judgment.
 */

function request(rawKey: string | null) {
  return new NextRequest("http://localhost/api/agent/actions/x", {
    headers: rawKey ? { authorization: `Bearer ${rawKey}` } : {},
  });
}

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.moneyActions).where(eq(schema.moneyActions.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

async function makeMerchantWithAgent(name: string) {
  const merchant = await createTestMerchant(name);
  createdMerchantIds.push(merchant.id);
  const rawKey = generateApiKey();
  const [agent] = await db
    .insert(schema.agents)
    .values({ merchantId: merchant.id, name: `${name}_agent`, apiKeyHash: hashApiKey(rawKey), status: "active" })
    .returning();
  return { merchant, agent, rawKey };
}

describe("GET /api/agent/actions/[id]", () => {
  it("401s with no auth", async () => {
    const res = await GET(request(null), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("404s for an unknown action id", async () => {
    const { rawKey } = await makeMerchantWithAgent("__actions_route_unknown__");
    const res = await GET(request(rawKey), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
  });

  it("includes a `why` section with the real recorded reason and bound for a denied action", async () => {
    const { merchant, agent, rawKey } = await makeMerchantWithAgent("__actions_route_why__");

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({
        merchantId: merchant.id,
        agentId: agent.id,
        type: "order_create",
        amountPaise: 10_000,
        status: "denied",
      })
      .returning();

    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Denied — route-test fixture: another request consumed the remaining stock between check and reservation.",
      boundApplied: "product_stock",
      moneyActionId: moneyAction.id,
    });

    const res = await GET(request(rawKey), { params: Promise.resolve({ id: moneyAction.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(moneyAction.id);
    expect(body.why).toBeDefined();
    expect(body.why.reason).toContain("route-test fixture");
    expect(body.why.bound).toBe("Not enough stock");
    expect(body.why.determinism).toBe("deterministic");
  });

  it("has no `why` section for an action with no recorded decision (e.g. still executing)", async () => {
    const { merchant, agent, rawKey } = await makeMerchantWithAgent("__actions_route_no_why__");

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({
        merchantId: merchant.id,
        agentId: agent.id,
        type: "order_create",
        amountPaise: 10_000,
        status: "executed",
      })
      .returning();

    const res = await GET(request(rawKey), { params: Promise.resolve({ id: moneyAction.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.why).toBeUndefined();
  });

  it("agent isolation: agent B cannot read agent A's action by id, even within the same merchant", async () => {
    const { merchant, agent: agentA, rawKey: rawKeyA } = await makeMerchantWithAgent("__actions_route_iso_a__");
    const rawKeyB = generateApiKey();
    await db.insert(schema.agents).values({ merchantId: merchant.id, name: "__actions_route_iso_b_agent__", apiKeyHash: hashApiKey(rawKeyB), status: "active" });

    const [moneyAction] = await db
      .insert(schema.moneyActions)
      .values({ merchantId: merchant.id, agentId: agentA.id, type: "order_create", amountPaise: 10_000, status: "denied" })
      .returning();
    await logAuditEntry({
      merchantId: merchant.id,
      actor: "agent",
      event: "money_action_attempt:order_create",
      decision: "deny",
      reason: "Denied — isolation fixture, belongs to agent A only.",
      boundApplied: "product_stock",
      moneyActionId: moneyAction.id,
    });

    // agent A can read its own action and its why.
    const resA = await GET(request(rawKeyA), { params: Promise.resolve({ id: moneyAction.id }) });
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    expect(bodyA.why?.reason).toContain("isolation fixture");

    // agent B, same merchant, different agent — must 404, not leak.
    const resB = await GET(request(rawKeyB), { params: Promise.resolve({ id: moneyAction.id }) });
    expect(resB.status).toBe(404);
  });
});
