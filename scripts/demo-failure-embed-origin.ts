import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db, schema } from "@/lib/db";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { updateEmbedOrigins } from "@/lib/embed-mutations";
import { getRecentAuditEntries } from "@/lib/audit";
import { POST as chatPOST } from "@/app/api/chat/route";

/**
 * Layer 10's failure demo: a merchant has embedded ThirdMan's widget on
 * their real site (an allowed origin), but a request arrives claiming
 * to be from a DIFFERENT origin — the widget copy-pasted onto a site
 * they never registered, or a script probing with a stolen embed key.
 * The origin allowlist is a deterministic bound, enforced by code
 * (embed-cors.ts), not a model — denied before the request ever reaches
 * the LLM-backed chat handler, and the denial is real, logged evidence,
 * not a silent drop. Repeatable, self-cleaning.
 */
async function main() {
  console.log("=== Demo: embed request from an unregistered origin ===\n");

  const [merchant] = await db
    .insert(schema.merchants)
    .values({
      name: "Demo Merchant — Embed Origin Scenario",
      email: `demo_embed_origin_${Date.now()}@test.invalid`,
      passwordHash: "demo:not-a-real-hash",
    })
    .returning();

  try {
    const config = await getOrCreateEmbedConfig(merchant.id);
    await updateEmbedOrigins({ merchantId: merchant.id, origins: ["https://real-merchant-site.example.com"] });

    console.log(`Merchant "${merchant.name}" registered their embed for https://real-merchant-site.example.com only.\n`);
    console.log(`A request arrives claiming Origin: https://not-their-site.example.com, using their real embed key.\n`);

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://not-their-site.example.com",
        "x-embed-key": config.publishableKey,
      },
      body: JSON.stringify({
        merchantId: merchant.id,
        sessionToken: crypto.randomUUID(),
        message: "hello",
      }),
    });

    const res = await chatPOST(req);
    const body = await res.json();

    console.log(`HTTP status: ${res.status}`);
    console.log(`Response: ${JSON.stringify(body)}\n`);

    if (res.status !== 400 || !body.error?.includes("not on this merchant's embed allowlist")) {
      throw new Error(`Expected a 400 naming the origin allowlist, got: ${res.status} — ${JSON.stringify(body)}`);
    }

    if (res.headers.get("access-control-allow-origin")) {
      throw new Error("Expected no CORS headers on a denied request — a browser must not be able to read this response cross-origin either.");
    }

    console.log("Denied deterministically, before any LLM call was made — no Groq/Gemini spend on a request that was never going to be allowed.\n");

    const trail = await getRecentAuditEntries(merchant.id, 5);
    const entry = trail.find((e) => e.event === "embed_origin_denied");
    if (!entry) {
      throw new Error("Expected a real embed_origin_denied audit entry");
    }
    console.log("Audit trail entry confirming this was logged as real evidence:");
    console.log(`  [${entry.decision.toUpperCase()}] ${entry.reason}`);
    console.log(`  Bound applied: ${entry.boundApplied}\n`);

    console.log("The merchant's real site, the one they actually registered, is completely unaffected.");
  } finally {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    await db.delete(schema.embedConfigs).where(eq(schema.embedConfigs.merchantId, merchant.id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
