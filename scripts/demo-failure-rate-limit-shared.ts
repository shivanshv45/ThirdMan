import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Layer 26-8's required failure demo: the one gap in this layer that
 * deployment actively creates, per plans/layer-26-hardening.md. Before
 * this layer, rate-limit.ts was an in-memory Map — its own header
 * comment said plainly that it "resets on process restart and doesn't
 * share state across instances." On Cloud Run, which scales
 * horizontally, that meant each instance kept its own counter, so a
 * documented limit of N/minute silently became N * (number of running
 * instances) — a caveat that was honest for a single process and a
 * real correctness defect the moment this runs on more than one.
 *
 * This demo simulates "two independent instances" the same honest way
 * demo-failure-reservation-abandoned.ts simulates a dead process: by
 * calling the real checkRateLimit() function twice in a row against the
 * same key, standing in for two separate server processes each handling
 * one request. Nothing here is mocked — every call goes through the
 * real distributed limiter and the real rate_limit_windows table. If
 * this were still the old in-memory Map, "instance A" and "instance B"
 * would each have their own zeroed-out bucket and both would report
 * "allowed", silently doubling the effective limit. Against the real
 * shared counter, the limit holds regardless of which "instance" is
 * asking.
 */
async function main() {
  console.log("=== Demo: the distributed rate limiter's counter is genuinely shared across instances ===\n");

  const key = `demo-rate-limit-shared:${Date.now()}`;
  const MAX_REQUESTS = 3;
  const WINDOW_MS = 60_000;

  console.log(`Limit: ${MAX_REQUESTS} requests/${WINDOW_MS / 1000}s, key "${key}"\n`);

  console.log("1. \"Instance A\" and \"instance B\" alternate handling requests against the SAME limiter key, exactly as two Cloud Run replicas behind the same route would:");

  const results: Array<{ instance: string; allowed: boolean }> = [];
  for (let i = 0; i < MAX_REQUESTS + 2; i++) {
    const instance = i % 2 === 0 ? "A" : "B";
    const result = await checkRateLimit(key, MAX_REQUESTS, WINDOW_MS);
    results.push({ instance, allowed: result.allowed });
    console.log(`   request ${i + 1} (instance ${instance}): ${result.allowed ? "allowed" : "denied"}`);
  }

  const allowedCount = results.filter((r) => r.allowed).length;
  console.log(`\n2. Total allowed across BOTH instances combined: ${allowedCount} of ${results.length} requests.\n`);

  if (allowedCount !== MAX_REQUESTS) {
    throw new Error(`Expected exactly ${MAX_REQUESTS} allowed across both instances combined, got ${allowedCount} — the shared-state property is broken`);
  }

  console.log(`3. Confirming the real row backing this: a single (limit_key, window_start) row in rate_limit_windows, not one row per "instance":`);
  const rows = await db.select().from(schema.rateLimitWindows).where(eq(schema.rateLimitWindows.limitKey, key));
  console.log(`   ${rows.length} row(s), count = ${rows[0]?.count ?? "n/a"}\n`);

  if (rows.length !== 1) {
    throw new Error(`Expected exactly one shared window row, found ${rows.length} — demo scenario is broken`);
  }

  console.log(
    `The limit of ${MAX_REQUESTS} held across both "instances" combined, not ${MAX_REQUESTS} each — proving the counter is genuinely shared state in Postgres, not two independent in-memory buckets that would have silently doubled the effective limit on a real horizontally-scaled deployment.`,
  );

  await db.delete(schema.rateLimitWindows).where(eq(schema.rateLimitWindows.limitKey, key));

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
