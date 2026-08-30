import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { drainDueNotifications } from "@/lib/notifications/send";
import { expirePendingEscalations } from "@/lib/notifications/expiry";
import { scanForRestockedVariants } from "@/lib/restock";
import { sendDueMerchantDigests } from "@/lib/notifications/merchant-alerts";
import { sweepExpiredHolds } from "@/lib/escrow";
import { sweepExpiredOffers } from "@/lib/discount";
import { sweepAllAgents } from "@/lib/guardian";
import { sweepAbandonedReservations } from "@/lib/gate";
import { drainDueTasks } from "@/lib/runtime/runner";
import { sweepExpiredMemories } from "@/lib/memory/retrieve";

/**
 * The one scheduled entrypoint this stack has (Layer 11-3). There is no
 * background worker process here — Vercel Cron (production) or a
 * `curl`/loop (local/demo) is what actually calls this. Point Vercel
 * Cron at it in production per vercel.json; be honest that Vercel's
 * free tier runs cron at most once a day, so for a live demo the real
 * driver is a manual curl or a short loop, and this endpoint is what
 * makes the mechanism production-ready rather than a fiction.
 *
 * Each job below is isolated: one throwing must not stop the rest, and
 * every job is idempotent and safe under overlapping ticks — the
 * partial unique indexes (money_actions, webhook_deliveries,
 * notification_deliveries, restock_requests) are what make that true,
 * not an assumption that ticks never overlap.
 *
 * This is a SUPPLEMENT to, not a replacement for, existing opportunistic
 * sweeps (e.g. /dashboard/escrow calling sweepExpiredHolds on load) —
 * those stay, this just means a merchant who never opens the dashboard
 * still gets swept.
 */

function isAuthorized(req: NextRequest): boolean {
  if (!env.CRON_SECRET) return false;

  const header = req.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : req.nextUrl.searchParams.get("secret");
  if (!provided) return false;

  const expected = Buffer.from(env.CRON_SECRET);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

type JobResult = { job: string; ok: boolean; detail?: unknown; error?: string };

async function runJob(job: string, fn: () => Promise<unknown>): Promise<JobResult> {
  try {
    const detail = await fn();
    return { job, ok: true, detail };
  } catch (err) {
    console.error(`[cron] job "${job}" failed:`, err);
    return { job, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sweepEscrowAcrossMerchants(): Promise<{ merchantsSwept: number; totalRefunded: number }> {
  const merchants = await db.select({ id: schema.merchants.id }).from(schema.merchants);
  let totalRefunded = 0;
  for (const merchant of merchants) {
    totalRefunded += await sweepExpiredHolds(merchant.id);
  }
  return { merchantsSwept: merchants.length, totalRefunded };
}

export async function POST(req: NextRequest) {
  // Unauthenticated calls are rejected without revealing why, and are
  // not logged as an application error — this is a public URL that
  // will be scanned, and that's expected traffic, not an incident.
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: JobResult[] = [];

  results.push(await runJob("notifications:drain", () => drainDueNotifications()));
  results.push(await runJob("escrow:sweep-expired", () => sweepEscrowAcrossMerchants()));
  results.push(await runJob("offers:sweep-expired", () => sweepExpiredOffers()));
  results.push(await runJob("escalations:expire", () => expirePendingEscalations()));
  results.push(await runJob("restock:scan", () => scanForRestockedVariants()));
  results.push(await runJob("merchant-digests:send", () => sendDueMerchantDigests()));
  results.push(await runJob("guardian:sweep", () => sweepAllAgents()));
  results.push(await runJob("reservations:sweep-abandoned", () => sweepAbandonedReservations()));
  results.push(await runJob("runtime:drain", () => drainDueTasks()));
  results.push(await runJob("memory:sweep-expired", () => sweepExpiredMemories()));

  // Layer 10's outbound webhook queue, if it has landed — registered
  // here rather than each feature building its own trigger. Optional
  // import: this file must not fail to build if webhooks/runner.ts
  // isn't present yet in a given checkout of the branch.
  try {
    const { drainDueDeliveries } = await import("@/lib/webhooks/runner");
    results.push(await runJob("webhooks:drain", () => drainDueDeliveries()));
  } catch {
    // Not present yet in this branch state — not an error.
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ranAt: new Date().toISOString(), results }, { status: allOk ? 200 : 207 });
}

/** Convenience for a local/demo curl — identical behavior to POST. Vercel Cron itself issues GET requests. */
export async function GET(req: NextRequest) {
  return POST(req);
}
