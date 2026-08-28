import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRecoveryStats, getFailureQueue } from "@/lib/recovery/attribution";
import { loadDemoBatchAction, runRecoveryBatchAction } from "./actions";
import { FailureQueue } from "./failure-queue";
import { PageHeader, Surface, MoneyStat, Stat, Button, formatPaiseGrouped } from "@/components/ui";

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
    <div className="space-y-8">
      <PageHeader title="Revenue recovery" description="Failed payments, diagnosis, and bounded automatic recovery." />

      <Surface variant="raised" className="p-6">
        <div className="grid grid-cols-2 sm:grid-cols-[1.5fr_1fr_1fr] gap-6 items-end">
          <MoneyStat
            label="Recovered"
            paise={stats.recoveredPaise}
            tone="allow"
            size="primary"
            caption={`of ${formatPaiseGrouped(stats.totalFailedPaise)} failed — ${stats.recoveryRatePercent}%`}
          />
          <Stat
            label="Deliberately not attempted"
            value={attemptsDeclinedTotal}
            tone="escalate"
            caption="A stopping rule fired before money was spent chasing it"
          />
          <Stat label="Money-moving attempts made" value={stats.attemptsMade} />
        </div>

        <div className="flex flex-wrap gap-4 mt-5 pt-4 border-t border-ink-line-soft text-xs font-mono">
          <span className="text-on-ink-dim">
            <span className="text-on-ink">{stats.failureCount}</span> total failures
          </span>
          <span className="text-on-ink-dim">
            <span className="text-allow-bright">{stats.recoveredCount}</span> recovered
          </span>
          <span className="text-on-ink-dim">
            <span className="text-escalate-bright">{stats.recoveringCount}</span> recovering
          </span>
          <span className="text-on-ink-dim">
            <span className="text-on-ink-faint">{stats.writtenOffCount}</span> written off
          </span>
        </div>

        {stoppedByRuleEntries.length > 0 && (
          <p className="mt-3 text-xs text-on-ink-faint">
            Stopped by rule:{" "}
            {stoppedByRuleEntries.map(([rule, count]) => `${RULE_LABELS[rule] ?? rule} (${count})`).join(", ")}
          </p>
        )}

        <div className="flex gap-2 mt-5">
          <form action={loadDemoBatchAction}>
            <Button type="submit" size="sm" pendingLabel="Loading…">
              Load demo failure batch
            </Button>
          </form>
          <form action={runRecoveryBatchAction}>
            <Button type="submit" variant="primary" size="sm" pendingLabel="Running…">
              Run recovery on all pending
            </Button>
          </form>
        </div>
        <p className="text-xs text-on-ink-faint mt-2 max-w-[var(--measure)]">
          The demo batch loads labelled simulated failures — no real payment failed. Every recovery attempt made
          against them is real: it passes through the same spend-cap gate as any other agent purchase, creates a
          real Razorpay order, and is verified before anything counts as recovered.
        </p>
      </Surface>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">Failure queue</h2>
        <FailureQueue initialQueue={queue} initialStats={stats} />
      </section>
    </div>
  );
}
