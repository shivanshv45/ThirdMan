"use client";

import { useState, useTransition } from "react";
import { refreshAuditTrail, type AuditEntry } from "./actions";
import { formatPaise as rupees } from "@/lib/money";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const decisionStyles: Record<string, { border: string; text: string; label: string }> = {
  allow: { border: "border-green-500", text: "text-green-700", label: "Allowed" },
  deny: { border: "border-red-500", text: "text-red-700", label: "Denied" },
  escalate: { border: "border-amber-500", text: "text-amber-700", label: "Escalated" },
};

function decisionStyle(decision: string) {
  return decisionStyles[decision] ?? { border: "border-gray-300", text: "text-gray-500", label: "Event" };
}

export function AuditTrail({ initialEntries }: { initialEntries: AuditEntry[] }) {
  const [entries, setEntries] = useState(initialEntries);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  function handleRefresh() {
    startTransition(async () => {
      const fresh = await refreshAuditTrail();
      setEntries(fresh);
      setLastRefreshed(new Date());
    });
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Audit trail</h2>
        <div className="flex items-center gap-2">
          {lastRefreshed && (
            <span className="text-xs text-gray-400">Updated {formatDate(lastRefreshed)}</span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isPending}
            className="text-sm px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-50"
          >
            {isPending ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="space-y-1">
        {entries.length === 0 && <p className="text-sm text-gray-500">No entries yet.</p>}
        {entries.map((entry) => {
          const style = decisionStyle(entry.decision);
          const expanded = expandedId === entry.id;

          return (
            <div key={entry.id} className={`border-l-4 pl-3 py-2 text-sm ${style.border}`}>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold uppercase ${style.text}`}>{style.label}</span>
                <span className="text-xs text-gray-400 ml-auto">{formatDate(entry.createdAt)}</span>
              </div>
              <p className="text-gray-800">{entry.reason}</p>

              {(entry.boundApplied || entry.moneyAction || entry.event) && (
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className="text-xs text-blue-600 hover:underline mt-1"
                >
                  {expanded ? "Hide details" : "Show details"}
                </button>
              )}

              {expanded && (
                <div className="mt-1 space-y-0.5 bg-gray-50 border rounded px-2 py-1.5">
                  <p className="text-xs text-gray-500">
                    Event: <span className="font-mono">{entry.event}</span>
                  </p>
                  {entry.boundApplied && (
                    <p className="text-xs text-gray-500">
                      Bound: <span className="font-mono">{entry.boundApplied}</span>
                    </p>
                  )}
                  {entry.moneyAction && (
                    <p className="text-xs text-gray-500">
                      {entry.moneyAction.type} — {rupees(entry.moneyAction.amountPaise)} — {entry.moneyAction.status}
                      {entry.moneyAction.razorpayEntityId && ` — ${entry.moneyAction.razorpayEntityId}`}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
