"use client";

import { useState, useTransition } from "react";
import {
  refreshRecoveryData,
  runSingleRecoveryAction,
  type FailureQueueResult,
  type RecoveryStatsResult,
} from "./actions";
import { formatPaise as rupees } from "@/lib/money";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const statusStyles: Record<string, { bg: string; text: string; label: string }> = {
  new: { bg: "bg-gray-100", text: "text-gray-700", label: "New" },
  diagnosed: { bg: "bg-blue-100", text: "text-blue-800", label: "Diagnosed" },
  recovering: { bg: "bg-amber-100", text: "text-amber-800", label: "Recovering" },
  recovered: { bg: "bg-green-100", text: "text-green-800", label: "Recovered" },
  written_off: { bg: "bg-gray-200", text: "text-gray-600", label: "Written off" },
};

const outcomeStyles: Record<string, string> = {
  pending: "text-gray-500",
  succeeded: "text-green-700",
  failed: "text-red-700",
  abandoned: "text-gray-500",
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
        <p className="text-sm text-gray-500">
          {stats.failureCount} failure{stats.failureCount === 1 ? "" : "s"} on record
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={isPending}
          className="text-sm px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-50"
        >
          {isPending ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {queue.length === 0 && (
        <p className="text-sm text-gray-500">No failures yet — load the demo batch or wait for a real webhook event.</p>
      )}

      {queue.map(({ failure, attempts }) => {
        const style = statusStyles[failure.status] ?? statusStyles.new;
        const expanded = expandedId === failure.id;
        const diagnosis = failure.diagnosis as
          | { rootCause: string; category: string; recoverable: boolean; confidence: string; source: string }
          | null;

        return (
          <div key={failure.id} className="border rounded-lg p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{rupees(failure.amountPaise)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${style.bg} ${style.text}`}>{style.label}</span>
                  {failure.source === "simulated" && (
                    <span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700" title="This failure was loaded from the demo batch, not a real Razorpay decline.">
                      Simulated
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  {failure.declineCode}
                  {failure.declineDescription && ` — ${failure.declineDescription}`}
                </p>
                {diagnosis && <p className="text-sm text-gray-800 mt-1">{diagnosis.rootCause}</p>}
                <p className="text-xs text-gray-400 mt-1">{formatDate(failure.failedAt)}</p>
              </div>
              <div className="flex flex-col gap-2 items-end shrink-0">
                {failure.status !== "recovered" && failure.status !== "written_off" && (
                  <button
                    type="button"
                    onClick={() => runOne(failure.id)}
                    disabled={runningId === failure.id}
                    className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {runningId === failure.id ? "Running…" : "Run recovery"}
                  </button>
                )}
                {attempts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : failure.id)}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    {expanded ? "Hide attempts" : `Show attempts (${attempts.length})`}
                  </button>
                )}
              </div>
            </div>

            {expanded && (
              <div className="mt-3 space-y-2 border-t pt-3">
                {attempts.map((attempt) => (
                  <div key={attempt.id} className="text-sm border-l-2 pl-3 border-gray-300">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Attempt {attempt.attemptNumber}</span>
                      <span className="text-xs text-gray-500">{attempt.strategy}</span>
                      <span className={`text-xs font-semibold uppercase ${outcomeStyles[attempt.outcome]}`}>
                        {attempt.outcome}
                      </span>
                      {attempt.recoveredPaise > 0 && (
                        <span className="text-xs text-green-700">+{rupees(attempt.recoveredPaise)}</span>
                      )}
                    </div>
                    <p className="text-gray-700 mt-0.5">{attempt.reason}</p>
                    {attempt.paymentLinkUrl && attempt.outcome === "pending" && (
                      <a
                        href={attempt.paymentLinkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline break-all"
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
