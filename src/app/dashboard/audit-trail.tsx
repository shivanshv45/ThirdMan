"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
  // "connecting" until the first message/open event lands, then "live"
  // or "unavailable" — the manual Refresh button always stays usable
  // regardless of state, so this never blocks the existing fallback.
  // Lazy initializer (not an effect) decides "unavailable" up front so
  // no setState is needed synchronously inside the effect below.
  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "unavailable">(() =>
    typeof EventSource === "undefined" ? "unavailable" : "connecting",
  );
  const seenIds = useRef(new Set(initialEntries.map((e) => e.id)));

  function handleRefresh() {
    startTransition(async () => {
      const fresh = await refreshAuditTrail();
      setEntries(fresh);
      seenIds.current = new Set(fresh.map((e) => e.id));
      setLastRefreshed(new Date());
    });
  }

  useEffect(() => {
    // Layer 15-3's explicit degrade-gracefully requirement: if
    // EventSource isn't available at all, streamStatus was already
    // initialized to "unavailable" above and the manual Refresh button
    // works exactly as it always has — nothing more to do here.
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/dashboard/decisions/stream");

    source.addEventListener("open", () => setStreamStatus("live"));
    source.addEventListener("error", () => {
      // EventSource auto-reconnects on its own; this only reflects the
      // gap in the status indicator so it doesn't lie about being live
      // while disconnected. The stream never needs the merchant to
      // acknowledge anything to recover.
      setStreamStatus((prev) => (prev === "live" ? "connecting" : prev));
    });
    source.addEventListener("decision", (event: MessageEvent<string>) => {
      const entry = JSON.parse(event.data) as AuditEntry;
      if (seenIds.current.has(entry.id)) return;
      seenIds.current.add(entry.id);
      setEntries((prev) => [entry, ...prev]);
      setStreamStatus("live");
    });

    return () => source.close();
  }, []);

  return (
    <section>
      <div className="flex items-end justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink">Decision stream</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            Every money action, the bound that applied, and why — newest first.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {streamStatus === "live" && (
            <span className="flex items-center gap-1.5 text-xs text-on-ink-faint">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-allow animate-pulse" />
              Live
            </span>
          )}
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
        <div className="rounded-[var(--radius-lg)] border border-ink-line overflow-hidden">
          {entries.map((entry, i) => {
            const expanded = expandedId === entry.id;
            const hasDetail = !!(entry.boundApplied || entry.moneyAction || entry.event);

            return (
              <div
                key={entry.id}
                className={`group relative transition-colors duration-[var(--dur-fast)] hover:bg-ink-raised ${
                  i > 0 ? "border-t border-ink-line-soft" : ""
                } ${expanded ? "bg-ink-raised" : ""}`}
              >
                {/* Aligned columns are what make a log read as an instrument
                    rather than a stack of sentences: decision, reason, and
                    time each hold their own vertical line at every row. */}
                <div className="grid md:grid-cols-[8rem_1fr_auto] gap-x-4 gap-y-1.5 px-4 py-3 items-baseline">
                  <DecisionBadge decision={asDecision(entry.decision)} compact />

                  <div className="min-w-0">
                    <p className="text-sm text-on-ink">{entry.reason}</p>
                    {hasDetail && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                        aria-expanded={expanded}
                        className="mt-1 text-xs text-on-ink-faint hover:text-accent-bright transition-colors duration-[var(--dur-fast)]"
                      >
                        {expanded ? "Hide detail" : "Detail"}
                      </button>
                    )}
                  </div>

                  <span className="text-xs text-on-ink-faint font-mono tabular-nums whitespace-nowrap md:text-right">
                    {formatDate(entry.createdAt)}
                  </span>
                </div>

                {expanded && (
                  <dl className="mx-4 mb-3 md:ml-[9rem] grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-l border-ink-line pl-4 font-mono text-xs">
                    <dt className="text-on-ink-faint">event</dt>
                    <dd className="text-on-ink break-all">{entry.event}</dd>

                    {entry.boundApplied && (
                      <>
                        <dt className="text-on-ink-faint">bound</dt>
                        <dd className="text-on-ink break-all">{entry.boundApplied}</dd>
                      </>
                    )}

                    {entry.moneyAction && (
                      <>
                        <dt className="text-on-ink-faint">action</dt>
                        <dd className="text-on-ink break-all">
                          {entry.moneyAction.type}
                          <span className="text-on-ink-faint"> · </span>
                          <span className="tabular-nums">{rupees(entry.moneyAction.amountPaise)}</span>
                          <span className="text-on-ink-faint"> · </span>
                          {entry.moneyAction.status}
                          {entry.moneyAction.razorpayEntityId && (
                            <>
                              <span className="text-on-ink-faint"> · </span>
                              {entry.moneyAction.razorpayEntityId}
                            </>
                          )}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
