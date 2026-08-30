import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { verifyRefusalReceipt } from "@/lib/refusal-receipt";
import { GET as manifestGET } from "@/app/store/[merchantId]/manifest.json/route";
import { POST as purchasePOST } from "@/app/api/agent/purchase/route";

/**
 * L21-5/L21-6: the test that matters — a receipt this merchant signed
 * verifies against the public key L21-2 published, fetched over HTTP. A
 * real round trip, not a string comparison: it proves the advertised
 * key, the signing path, and the receipt are the same system.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const agentIdsSubquery = db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.agentCapabilities).where(inArray(schema.agentCapabilities.agentId, agentIdsSubquery));
    await db.delete(schema.spendCaps).where(inArray(schema.spendCaps.agentId, agentIdsSubquery));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.agents).where(eq(schema.agents.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("refusal receipts — the real round trip", () => {
  it("a denial's receipt verifies against the merchant's public key fetched from its own published manifest", async () => {
    const merchant = await createTestMerchant("__receipt_roundtrip__");
    createdMerchantIds.push(merchant.id);

    const rawKey = generateApiKey();
    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchant.id, name: "__receipt_test_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
      .returning();
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "purchase:create" });

    // No spend cap at all — a guaranteed, real deny.
    const purchaseReq = new NextRequest("http://localhost/api/agent/purchase", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ amountPaise: 10_000, context: "receipt round trip test" }),
    });
    const purchaseRes = await purchasePOST(purchaseReq);
    const purchaseBody = await purchaseRes.json();
    expect(purchaseBody.decision).toBe("deny");
    expect(typeof purchaseBody.receipt).toBe("string");

    // Fetch the published public key over the real manifest route —
    // never read from mandates.ts's own storage directly, since the
    // point is proving the ADVERTISED key is the one that verifies.
    const manifestReq = new NextRequest(`http://localhost/store/${merchant.id}/manifest.json`);
    const manifestRes = await manifestGET(manifestReq, { params: Promise.resolve({ merchantId: merchant.id }) });
    const manifest = await manifestRes.json();
    const publicKeySpki = manifest.protocolSupport.ap2.publicKey.value;
    expect(typeof publicKeySpki).toBe("string");

    const claims = await verifyRefusalReceipt(purchaseBody.receipt, publicKeySpki);
    expect(claims.merchantId).toBe(merchant.id);
    expect(claims.decision).toBe("deny");
    expect(claims.reason).toBe(purchaseBody.reason);
    expect(claims.determinism).toBe("deterministic");
  }, 20_000);

  it("verification fails against a different merchant's public key", async () => {
    const merchantA = await createTestMerchant("__receipt_wrong_key_a__");
    const merchantB = await createTestMerchant("__receipt_wrong_key_b__");
    createdMerchantIds.push(merchantA.id, merchantB.id);

    const rawKey = generateApiKey();
    const [agent] = await db
      .insert(schema.agents)
      .values({ merchantId: merchantA.id, name: "__receipt_wrong_key_agent__", apiKeyHash: hashApiKey(rawKey), status: "active" })
      .returning();
    await db.insert(schema.agentCapabilities).values({ agentId: agent.id, capability: "purchase:create" });

    const purchaseReq = new NextRequest("http://localhost/api/agent/purchase", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ amountPaise: 10_000, context: "wrong key test" }),
    });
    const purchaseRes = await purchasePOST(purchaseReq);
    const purchaseBody = await purchaseRes.json();
    expect(typeof purchaseBody.receipt).toBe("string");

    const manifestReq = new NextRequest(`http://localhost/store/${merchantB.id}/manifest.json`);
    const manifestRes = await manifestGET(manifestReq, { params: Promise.resolve({ merchantId: merchantB.id }) });
    const manifest = await manifestRes.json();
    const wrongPublicKey = manifest.protocolSupport.ap2.publicKey.value;

    await expect(verifyRefusalReceipt(purchaseBody.receipt, wrongPublicKey)).rejects.toThrow();
  }, 20_000);
});
