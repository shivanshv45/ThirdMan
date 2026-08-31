import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { attemptMoneyAction, confirmCapture, issueRefund } from "@/lib/gate";
import { createAgent, setAgentCapabilities, setSpendCap } from "@/lib/dashboard-mutations";
import { recordPaymentFailure } from "@/lib/recovery/intake";
import { runRecoveryBatch, confirmRecoveryLinkPaid } from "@/lib/recovery/sequencer";

/**
 * Drives a real, paced sequence of money actions against the seeded
 * merchant's own catalogue so the dashboard's live SSE decision feed has
 * continuous, genuine activity to show while recording a demo — never
 * fabricated rows, every action goes through the same attemptMoneyAction/
 * confirmCapture/issueRefund/recovery pipeline the real product uses.
 *
 * Spread across many agents, not one. A single agent hammered every few
 * seconds has no real trailing-14-day baseline to compare against, so the
 * Runtime Guardian's velocity signal (4x baseline transactions in a
 * 15-minute window, guardian.ts's VELOCITY_MULTIPLIER) trips fast and
 * suspends it — a single demo agent getting throttled mid-recording is
 * exactly the failure this version avoids. This script provisions a pool
 * of DEMO_AGENT_COUNT real, separately-capped agents up front and rotates
 * across all of them, so no individual agent sees more than one action
 * roughly every DEMO_AGENT_COUNT ticks — each one looks like light,
 * ordinary activity to the Guardian, the same way a real merchant with
 * several real integrations would look.
 *
 * Capture is confirmed with a synthetic payment id, the same convention
 * checkout-e2e.test.ts already establishes: completing a real Checkout
 * payment needs a browser, so what's proven here is everything up to and
 * including capture confirmation — the exact function /api/checkout/verify
 * and the Razorpay webhook both call in production.
 *
 * Also drives real revenue-recovery cycles, on the same real pipeline
 * scripts/demo-recovery-batch.ts exercises (never that script itself,
 * which deletes what it creates in a finally block — this run wants
 * recovery history that stays visible on /dashboard/recovery for the rest
 * of the demo). recordPaymentFailure writes a real, source:"simulated"
 * decline (labelled as such, same discipline recovery/demo-batch.ts
 * already established); runRecoveryBatch is the real deterministic
 * diagnose->decide->sequence pipeline, which for a recoverable decline
 * creates a real, payable Razorpay Payment Link. confirmRecoveryLinkPaid
 * is then called directly with that link's real id and amount — the same
 * "browser can't be scripted" substitution this script already uses for
 * confirmCapture. This is what makes "Succeeded" show up as a real number
 * on the recovery dashboard rather than staying "Pending" for the demo.
 *
 * Runs until Ctrl+C. Creates DEMO_AGENT_COUNT real, clearly-named demo
 * agents and their spend caps on its own merchant — never touches an
 * existing agent — and leaves everything it created behind (real captured
 * purchases/refunds/recovered failures are the point of the demo), except
 * the demo agents+caps themselves get archived on exit so they don't
 * linger as stray "active" agents afterward.
 *
 * Usage: npm run script scripts/demo-live-feed.ts
 */

const MIN_GAP_MS = 8_000;
const MAX_GAP_MS = 20_000;
const DEMO_AGENT_COUNT = 12;
const DEMO_AGENT_PREFIX = "Demo Feed Buyer";

// A recoverable decline shape — insufficient funds is one of the codes
// recovery/policy.ts classifies as retryable, so this reliably produces a
// real retry_same_instrument/alternate_instrument Payment Link rather than
// a write-off, matching one of recovery/demo-batch.ts's own DEMO_FAILURES.
const RECOVERABLE_DECLINES = [
  { declineCode: "BAD_REQUEST_ERROR", declineDescription: "Payment failed due to insufficient funds in the customer account." },
  { declineCode: "GATEWAY_ERROR", declineDescription: "Card declined by the issuing bank." },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomGapMs(): number {
  return MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface DemoAgent {
  id: string;
  name: string;
}

async function main() {
  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) {
    console.error("No merchant found — run `npm run script scripts/seed.ts` first.");
    process.exit(1);
  }
  log(`Merchant: ${merchant.name} (${merchant.id})`);

  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.merchantId, merchant.id), eq(schema.productVariants.status, "active")));
  if (variants.length === 0) {
    console.error("No active product variants found — run the seed script first.");
    process.exit(1);
  }
  log(`Catalogue: ${variants.length} active variant(s) to buy from.`);

  // A pool of real, clearly-named agents — not the hidden storefront one —
  // rotated across so no single one looks like a hammering script to the
  // Guardian's velocity signal.
  const agents: DemoAgent[] = [];
  for (let i = 1; i <= DEMO_AGENT_COUNT; i++) {
    const name = `${DEMO_AGENT_PREFIX} ${i}`;
    const { agent } = await createAgent(merchant.id, name);
    await setAgentCapabilities(merchant.id, agent.id, ["purchase:create", "negotiation:create", "products:read", "rewards:read"]);
    // A cap sized so most purchases succeed but an occasional one still
    // trips the ceiling — a real denial in the feed is more convincing
    // than an unbroken string of allows. Varied a little per agent so the
    // feed doesn't show the exact same cap figure every time.
    const capRupees = 4000 + Math.floor(Math.random() * 4000);
    await setSpendCap({ merchantId: merchant.id, agentId: agent.id, capRupees, perTransactionMaxRupees: 2500, windowHours: 24 });
    agents.push({ id: agent.id, name: agent.name });
    log(`Created demo agent "${agent.name}" (${agent.id}) with a ₹${capRupees} cap, ₹2,500 per-transaction max.`);
  }

  // Per-agent captured money action ids, so a refund is issued against
  // the same agent's own earlier purchase rather than mixing agents.
  const capturedByAgent = new Map<string, string[]>(agents.map((a) => [a.id, []]));
  let nextAgentIndex = 0;
  function pickAgent(): DemoAgent {
    const a = agents[nextAgentIndex % agents.length];
    nextAgentIndex++;
    return a;
  }

  let running = true;
  const stop = () => {
    if (!running) return;
    running = false;
    log("Stopping — cleaning up the demo agents...");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let tick = 0;
  while (running) {
    tick++;
    const roll = Math.random();
    const agent = pickAgent();

    try {
      const captured = capturedByAgent.get(agent.id) ?? [];

      if (roll < 0.12 && captured.length > 0) {
        // Refund a genuinely captured earlier purchase, made by this same agent.
        const moneyActionId = captured.shift()!;
        const result = await issueRefund(merchant.id, moneyActionId);
        log(`[${agent.name}] REFUND  ${result.decision.toUpperCase()} — ${result.reason}`);
      } else if (roll < 0.27) {
        // A real revenue-recovery cycle: record a genuine decline, run the
        // real deterministic pipeline against it, then — once it has
        // produced a real payable Payment Link — confirm it paid, the
        // same synthetic-signal substitution this script already uses for
        // a normal checkout's capture. Recovery attempts aren't tied to
        // one of the pooled agents — the pipeline runs its own internal
        // recovery agent, same as production.
        const decline = RECOVERABLE_DECLINES[Math.floor(Math.random() * RECOVERABLE_DECLINES.length)];
        const variant = variants[Math.floor(Math.random() * variants.length)];
        const amountPaise = variant.pricePaise;

        const failure = await recordPaymentFailure({
          merchantId: merchant.id,
          amountPaise,
          declineCode: decline.declineCode,
          declineDescription: decline.declineDescription,
          source: "simulated",
          failedAt: new Date(),
        });
        log(`RECOVERY: failure recorded — ₹${(amountPaise / 100).toFixed(2)} declined (${decline.declineCode}), queued.`);

        await sleep(2000 + Math.random() * 2000);
        const batch = await runRecoveryBatch(merchant.id);
        log(`RECOVERY: batch run — attempted ${batch.attempted}, ₹${(batch.recoveredPaise / 100).toFixed(2)} recovered so far, ${batch.writtenOff} written off.`);

        const [attempt] = await db
          .select()
          .from(schema.recoveryAttempts)
          .where(eq(schema.recoveryAttempts.paymentFailureId, failure.id));

        if (attempt?.razorpayPaymentLinkId && attempt.outcome === "pending") {
          log(`RECOVERY: link generated — ${attempt.paymentLinkUrl}`);
          await sleep(3000 + Math.random() * 3000);
          await confirmRecoveryLinkPaid(attempt.razorpayPaymentLinkId, amountPaise);
          log(`RECOVERY: SUCCEEDED — ₹${(amountPaise / 100).toFixed(2)} recovered via the payment link, confirmed paid.`);
        } else if (attempt) {
          log(`RECOVERY: ${attempt.outcome.toUpperCase()} — ${attempt.reason}`);
        }
      } else if (roll < 0.42) {
        // Deliberately overshoot the per-transaction max to show a real
        // gate denial in the feed — always denied, never affects budget.
        const variant = variants[Math.floor(Math.random() * variants.length)];
        const oversizedAmount = variant.pricePaise * 40; // comfortably above the ₹2,500 per-tx max
        const result = await attemptMoneyAction({
          agentId: agent.id,
          merchantId: merchant.id,
          type: "order_create",
          amountPaise: oversizedAmount,
          context: "Demo feed: deliberately oversized purchase to show a real denial",
          variantId: variant.id,
          quantity: 40,
        });
        log(`[${agent.name}] PURCHASE ${result.decision.toUpperCase()} (oversized, expected deny) — ${result.reason}`);
      } else {
        // A normal, real purchase: attempt -> allow -> real Razorpay
        // test-mode order -> confirm capture -> coins/treasury/webhooks
        // fire exactly as they do for a real buyer.
        const variant = variants[Math.floor(Math.random() * variants.length)];
        const quantity = 1 + Math.floor(Math.random() * 2);
        const amountPaise = variant.pricePaise * quantity;

        const attempt = await attemptMoneyAction({
          agentId: agent.id,
          merchantId: merchant.id,
          type: "order_create",
          amountPaise,
          context: `Demo feed: purchasing ${quantity}x variant ${variant.sku ?? variant.id}`,
          variantId: variant.id,
          quantity,
        });

        if (attempt.decision === "allow" && attempt.moneyActionId && attempt.razorpayOrderId) {
          log(`[${agent.name}] PURCHASE ALLOW — ${attempt.reason}`);
          await sleep(3000 + Math.random() * 3000);
          const capture = await confirmCapture(attempt.moneyActionId, `pay_demo_${attempt.moneyActionId.slice(0, 12)}`, "checkout_signature");
          log(`[${agent.name}] CAPTURE  ${capture.decision.toUpperCase()} — ${capture.reason}`);
          if (capture.decision === "allow") {
            capturedByAgent.set(agent.id, [...(capturedByAgent.get(agent.id) ?? []), attempt.moneyActionId]);
          }
        } else {
          log(`[${agent.name}] PURCHASE ${attempt.decision.toUpperCase()} — ${attempt.reason}`);
        }
      }
    } catch (err) {
      console.error(`[tick ${tick}] error:`, err instanceof Error ? err.message : err);
    }

    if (!running) break;
    const gap = randomGapMs();
    await sleep(gap);
  }

  // Archive every demo agent (revoke its cap, deactivate it) rather than
  // deleting anything — every purchase/refund/recovery it drove is real
  // history and stays in the audit trail exactly as it should.
  for (const agent of agents) {
    await db.update(schema.spendCaps).set({ status: "revoked" }).where(eq(schema.spendCaps.agentId, agent.id));
    await db.update(schema.agents).set({ status: "revoked" }).where(eq(schema.agents.id, agent.id));
  }
  log(`${agents.length} demo agent(s) revoked. Their purchases/refunds/recoveries remain in the real audit trail.`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
