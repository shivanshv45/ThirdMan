"use client";

import { useState, useTransition } from "react";
import {
  refreshRecoveryData,
  runSingleRecoveryAction,
  type FailureQueueResult,
  type RecoveryStatsResult,
} from "./actions";
import { formatPaise as rupees } from "@/lib/money";
import { EmptyState } from "@/components/ui";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const statusStyles: Record<string, { bg: string; text: string; label: string }> = {
  new: { bg: "bg-ink-overlay", text: "text-on-ink-dim", label: "New" },
  diagnosed: { bg: "bg-accent-wash", text: "text-accent-bright", label: "Diagnosed" },
  recovering: { bg: "bg-escalate-wash", text: "text-escalate-bright", label: "Recovering" },
  recovered: { bg: "bg-allow-wash", text: "text-allow-bright", label: "Recovered" },
  written_off: { bg: "bg-ink-overlay", text: "text-on-ink-faint", label: "Written off" },
};

const outcomeStyles: Record<string, string> = {
  pending: "text-on-ink-faint",
  succeeded: "text-allow-bright",
  failed: "text-deny-bright",
  abandoned: "text-on-ink-faint",
};

export function FailureQueue({
  initialQueue,
  initialStats,
}: {
  initialQueue: FailureQueueResult;
  initialStats: RecoveryStatsResult;
}) {
  const [queue, setQueue] = useState(initialQueue);
  const [stats, setStats] = useState(initialStats);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(null);

  function refresh() {
    startTransition(async () => {
      const fresh = await refreshRecoveryData();
      setQueue(fresh.queue);
      setStats(fresh.stats);
    });
  }

  async function runOne(failureId: string) {
    setRunningId(failureId);
    const formData = new FormData();
    formData.set("failureId", failureId);
    await runSingleRecoveryAction(formData);
    setRunningId(null);
    refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-on-ink-dim">
          {stats.failureCount} failure{stats.failureCount === 1 ? "" : "s"} on record
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={isPending}
          className="text-sm px-3 py-1.5 rounded-[var(--radius)] bg-ink-overlay border border-ink-line text-on-ink hover:border-on-ink-faint disabled:opacity-50 transition-colors duration-[var(--dur-fast)]"
        >
          {isPending ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {queue.length === 0 && (
        <EmptyState title="No failures yet" description="Load the demo batch or wait for a real webhook event." />
      )}

      {queue.map(({ failure, attempts }) => {
        const style = statusStyles[failure.status] ?? statusStyles.new;
        const expanded = expandedId === failure.id;
        const diagnosis = failure.diagnosis as
          | { rootCause: string; category: string; recoverable: boolean; confidence: string; source: string }
          | null;
        const isDone = failure.status === "recovered" || failure.status === "written_off";
        const isRunning = runningId === failure.id;

        return (
          <div key={failure.id} className="rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-on-ink font-mono">{rupees(failure.amountPaise)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                  {failure.source === "simulated" && (
                    <span
                      className="text-xs px-2 py-0.5 rounded-full bg-ink-overlay text-on-ink-faint"
                      title="This failure was loaded from the demo batch, not a real Razorpay decline."
                    >
                      Simulated
                    </span>
                  )}
                </div>
                <p className="text-sm text-on-ink-dim mt-1.5">
                  {failure.declineCode}
                  {failure.declineDescription && ` — ${failure.declineDescription}`}
                </p>
                {diagnosis && <p className="text-sm text-on-ink mt-1">{diagnosis.rootCause}</p>}
                <p className="text-xs text-on-ink-faint mt-1 font-mono">{formatDate(failure.failedAt)}</p>
              </div>
              <div className="flex flex-col gap-2 items-end shrink-0">
                {!isDone && (
                  <button
                    type="button"
                    onClick={() => runOne(failure.id)}
                    disabled={isRunning}
                    className="text-sm px-3 py-1.5 rounded-[var(--radius)] bg-accent text-accent-ink hover:bg-accent-bright disabled:opacity-50 font-medium transition-colors duration-[var(--dur-fast)] inline-flex items-center gap-1.5"
                  >
                    {isRunning && (
                      <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
                    )}
                    {isRunning ? "Running…" : "Run recovery"}
                  </button>
                )}
                {attempts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : failure.id)}
                    className="text-xs text-accent hover:text-accent-bright transition-colors"
                  >
                    {expanded ? "Hide attempts" : `Show attempts (${attempts.length})`}
                  </button>
                )}
              </div>
            </div>

            {expanded && (
              <div className="mt-3 space-y-2.5 border-t border-ink-line-soft pt-3">
                {attempts.map((attempt) => (
                  <div key={attempt.id} className="text-sm pl-3 border-l-2 border-ink-line">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-on-ink">Attempt {attempt.attemptNumber}</span>
                      <span className="text-xs text-on-ink-faint font-mono">{attempt.strategy}</span>
                      <span className={`text-xs font-semibold uppercase ${outcomeStyles[attempt.outcome]}`}>
                        {attempt.outcome}
                      </span>
                      {attempt.recoveredPaise > 0 && (
                        <span className="text-xs text-allow-bright font-mono">+{rupees(attempt.recoveredPaise)}</span>
                      )}
                    </div>
                    <p className="text-on-ink-dim mt-0.5">{attempt.reason}</p>
                    {attempt.paymentLinkUrl && attempt.outcome === "pending" && (
                      <a
                        href={attempt.paymentLinkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-accent hover:text-accent-bright break-all font-mono"
                      >
                        {attempt.paymentLinkUrl}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
