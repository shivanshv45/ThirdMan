import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Layer 19-5: where the standalone agent-buyer/ package's local JSONL
 * run log reaches the product, so the Theatre view can show it without
 * ever giving that package database access (its own governing rule —
 * plans/layer-19-adversarial-buyer.md). Authenticates exactly like
 * every other /api/agent/* route — the buyer agent holds one ordinary
 * agent API key, no special casing (governing rule #4/#5).
 *
 * rawLog is stored verbatim as an opaque, untrusted blob (buyerAgentRuns
 * in schema.ts) — never parsed into a table anything else reads, never
 * trusted as a source of truth about a money action. The Theatre view's
 * decision-side panel comes from audit_log/money_actions, which this
 * endpoint never writes to.
 */

// Keyed by agent id, matching every other agent-facing route's rate
// limit shape. A run log is uploaded at most once per real run.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

// A generous but real ceiling — bounds what an untrusted caller can
// make this endpoint store, independent of anything agent-buyer/'s own
// bounds.ts enforces on its side (this server has no way to verify
// those were honored, so it enforces its own).
const MAX_RAW_LOG_BYTES = 2_000_000;

const ingestSchema = z.object({
  runId: z.string().min(1).max(200),
  rawLog: z.string().min(1).max(MAX_RAW_LOG_BYTES),
});

export async function POST(req: NextRequest) {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(`agent-theatre-ingest:${agent.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = ingestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  // Re-ingesting the same run (a resumed or repeated upload) replaces
  // the prior blob for that runId rather than accumulating duplicates —
  // one row per real run, matching moneyActions' own idempotency
  // discipline for repeat calls.
  const [existing] = await db
    .select({ id: schema.buyerAgentRuns.id })
    .from(schema.buyerAgentRuns)
    .where(and(eq(schema.buyerAgentRuns.agentId, agent.id), eq(schema.buyerAgentRuns.runId, parsed.data.runId)));

  if (existing) {
    await db.update(schema.buyerAgentRuns).set({ rawLog: parsed.data.rawLog }).where(eq(schema.buyerAgentRuns.id, existing.id));
    return NextResponse.json({ ok: true, id: existing.id, updated: true });
  }

  const [row] = await db
    .insert(schema.buyerAgentRuns)
    .values({ merchantId: agent.merchantId, agentId: agent.id, runId: parsed.data.runId, rawLog: parsed.data.rawLog })
    .returning({ id: schema.buyerAgentRuns.id });

  return NextResponse.json({ ok: true, id: row.id, updated: false });
}
