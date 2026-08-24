import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRecoveryStats, getFailureQueue } from "@/lib/recovery/attribution";
import { loadDemoBatchAction, runRecoveryBatchAction } from "./actions";
import { FailureQueue } from "./failure-queue";
import { formatPaise as rupees } from "@/lib/money";

const RULE_LABELS: Record<string, string> = {
  already_resolved: "Already resolved",
  unrecoverable_diagnosis: "Diagnosed unrecoverable",
  max_attempts_reached: "Attempt limit reached",
  backoff_window_not_elapsed: "Waiting on backoff",
  below_minimum_recoverable_amount: "Below minimum worth recovering",
  roi_governor: "ROI governor",
  high_value_requires_human: "High value — routed to human",
};

export default async function RecoveryPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [stats, queue] = await Promise.all([getRecoveryStats(merchant.id), getFailureQueue(merchant.id)]);

  const stoppedByRuleEntries = Object.entries(stats.stoppedByRule);
  const attemptsDeclinedTotal = stoppedByRuleEntries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Revenue recovery</h1>
        <p className="text-sm text-gray-500">Failed payments, diagnosis, and bounded automatic recovery</p>
      </header>

      <section className="border rounded-lg p-5 bg-gray-50">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <p className="text-3xl font-semibold">
              {rupees(stats.recoveredPaise)}{" "}
              <span className="text-lg text-gray-500 font-normal">
                of {rupees(stats.totalFailedPaise)} recovered — {stats.recoveryRatePercent}%
              </span>
            </p>
          </div>
          <div className="text-sm text-gray-600">
            {attemptsDeclinedTotal} attempt{attemptsDeclinedTotal === 1 ? "" : "s"} deliberately not made
          </div>
        </div>

        <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-600">
          <span>{stats.failureCount} total failures</span>
          <span>{stats.recoveredCount} recovered</span>
          <span>{stats.recoveringCount} recovering</span>
          <span>{stats.writtenOffCount} written off</span>
          <span>{stats.attemptsMade} money-moving attempts made</span>
        </div>

        {stoppedByRuleEntries.length > 0 && (
          <div className="mt-3 text-xs text-gray-500">
            Stopped by rule:{" "}
            {stoppedByRuleEntries
              .map(([rule, count]) => `${RULE_LABELS[rule] ?? rule} (${count})`)
              .join(", ")}
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <form action={loadDemoBatchAction}>
            <button type="submit" className="text-sm px-3 py-1.5 rounded border hover:bg-white">
              Load demo failure batch
            </button>
          </form>
          <form action={runRecoveryBatchAction}>
            <button type="submit" className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">
              Run recovery on all pending
            </button>
          </form>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          The demo batch loads labelled simulated failures — no real payment failed. Every recovery attempt made
          against them is real: it passes through the same spend-cap gate as any other agent purchase, creates a
          real Razorpay order, and is verified before anything counts as recovered.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Failure queue</h2>
        <FailureQueue initialQueue={queue} initialStats={stats} />
      </section>
    </main>
  );
}
