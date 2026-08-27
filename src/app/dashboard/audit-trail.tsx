"use client";

import { useState, useTransition } from "react";
import { refreshAuditTrail, type AuditEntry } from "./actions";
import { formatPaise as rupees } from "@/lib/money";
import { DecisionBadge, type Decision, Button, EmptyState } from "@/components/ui";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function asDecision(d: string): Decision {
  return d === "allow" || d === "deny" || d === "escalate" ? d : "n/a";
}

/**
 * The decision stream — the product's centrepiece (plans/layer-9,
 * fact 2/9). Real rows only: initialEntries is server-rendered from
 * the real audit_log, and Refresh calls the real refreshAuditTrail()
 * Server Action rather than a client-side interval faking "live."
 */
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
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink">Decision stream</h2>
        <div className="flex items-center gap-3">
          {lastRefreshed && (
            <span className="text-xs text-on-ink-faint font-mono">Updated {formatDate(lastRefreshed)}</span>
          )}
          <Button type="button" onClick={handleRefresh} disabled={isPending} size="sm" pendingLabel="Refreshing…">
            Refresh
          </Button>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="No decisions yet" description="Every allow, deny, and escalation will appear here as it happens." />
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-ink-line divide-y divide-ink-line-soft">
          {entries.map((entry) => {
            const expanded = expandedId === entry.id;

            return (
              <div key={entry.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <DecisionBadge decision={asDecision(entry.decision)} />
                  <p className="text-sm text-on-ink flex-1 min-w-0">{entry.reason}</p>
                  <span className="text-xs text-on-ink-faint font-mono whitespace-nowrap shrink-0">
                    {formatDate(entry.createdAt)}
                  </span>
                </div>

                {(entry.boundApplied || entry.moneyAction || entry.event) && (
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    className="text-xs text-accent hover:text-accent-bright mt-1.5 transition-colors"
                  >
                    {expanded ? "Hide details" : "Show details"}
                  </button>
                )}

                {expanded && (
                  <div className="mt-2 space-y-1 bg-ink-overlay border border-ink-line-soft rounded-[var(--radius)] px-3 py-2 font-mono text-xs text-on-ink-dim">
                    <p>
                      event: <span className="text-on-ink">{entry.event}</span>
                    </p>
                    {entry.boundApplied && (
                      <p>
                        bound: <span className="text-on-ink">{entry.boundApplied}</span>
                      </p>
                    )}
                    {entry.moneyAction && (
                      <p>
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
      )}
    </section>
  );
}
