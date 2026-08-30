"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TheatreRun, TheatreRunStep } from "@/lib/dashboard";
import type { AuditEntry } from "../actions";
import { formatPaise as rupees } from "@/lib/money";
import { DecisionBadge, type Decision, EmptyState } from "@/components/ui";

function formatTime(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function asDecision(d: string): Decision {
  return d === "allow" || d === "deny" || d === "escalate" ? d : "n/a";
}

/**
 * Non-terminal (the agent is still working) vs terminal steps, same
 * "real state, real label, no fabricated progress" discipline
 * /dashboard/tasks (Layer 17) established — no spinner implying work
 * between ticks when nothing is happening.
 */
function runStatus(run: TheatreRun): { decision: Decision; label: string } {
  if (!run.finalOutcome) return { decision: "escalate", label: "in progress" };
  if (run.finalOutcome === "succeeded") return { decision: "allow", label: "succeeded" };
  if (run.finalOutcome === "exhausted" || run.finalOutcome === "timed_out" || run.finalOutcome === "rate_limited") {
    return { decision: "escalate", label: run.finalOutcome };
  }
  return { decision: "deny", label: run.finalOutcome };
}

function stepLabel(step: TheatreRunStep): string {
  switch (step.type) {
    case "run_started":
      return "Run started";
    case "step":
      return "Reasoning";
    case "tool_call":
      return `Called ${step.toolName}`;
    case "tool_result":
      return `Result from ${step.toolName}`;
    case "run_ended":
      return `Run ended (${step.outcome})`;
    default:
      return step.type;
  }
}

export function TheatrePanel({
  run,
  verifiedMoneyActionIds,
  initialDecisions,
  runs,
}: {
  run: TheatreRun;
  verifiedMoneyActionIds: string[];
  initialDecisions: AuditEntry[];
  runs: TheatreRun[];
}) {
  const [decisions, setDecisions] = useState(initialDecisions);
  const [highlightedActionId, setHighlightedActionId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "unavailable">(() =>
    typeof EventSource === "undefined" ? "unavailable" : "connecting",
  );
  const seenIds = useRef(new Set(initialDecisions.map((e) => e.id)));
  const verifiedSet = useMemo(() => new Set(verifiedMoneyActionIds), [verifiedMoneyActionIds]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/dashboard/decisions/stream");
    source.addEventListener("open", () => setStreamStatus("live"));
    source.addEventListener("error", () => {
      setStreamStatus((prev) => (prev === "live" ? "connecting" : prev));
    });
    source.addEventListener("decision", (event: MessageEvent<string>) => {
      const entry = JSON.parse(event.data) as AuditEntry;
      if (seenIds.current.has(entry.id)) return;
      seenIds.current.add(entry.id);
      setDecisions((prev) => [entry, ...prev]);
      setStreamStatus("live");
    });
    return () => source.close();
  }, []);

  const status = runStatus(run);

  // A decision row's own moneyAction.id is the join key — a step is
  // "correlated" only when both sides genuinely name the same real id.
  // Never paired by proximity in time (the governing rule this view
  // exists to honor).
  const decisionByMoneyActionId = useMemo(() => {
    const map = new Map<string, AuditEntry>();
    for (const d of decisions) {
      if (d.moneyAction?.id) map.set(d.moneyAction.id, d);
    }
    return map;
  }, [decisions]);

  return (
    <div className="space-y-4">
      {runs.length > 1 && (
        <p className="text-xs text-on-ink-faint">Showing the most recent of {runs.length} uploaded runs.</p>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <DecisionBadge decision={status.decision} label={status.label} compact />
        <span className="text-sm text-on-ink-dim">
          Agent <span className="text-on-ink font-medium">{run.agentName}</span>
        </span>
        <span className="text-xs text-on-ink-faint font-mono">run {run.runId.slice(0, 8)}</span>
        {streamStatus === "live" && (
          <span className="flex items-center gap-1.5 text-xs text-on-ink-faint">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-allow animate-pulse" />
            Live
          </span>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <section>
          <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-1">Buyer agent</h2>
          <p className="text-sm text-on-ink-dim mb-3">Its own reasoning and tool calls, exactly as logged.</p>

          <div className="rounded-[var(--radius-lg)] border border-ink-line overflow-hidden max-h-[70vh] overflow-y-auto">
            {run.steps
              .filter((s) => s.type !== "tool_result")
              .map((step, i) => {
                const claimedId = step.moneyActionId;
                const verified = claimedId ? verifiedSet.has(claimedId) : false;
                const correlated = verified ? decisionByMoneyActionId.get(claimedId!) : undefined;

                return (
                  <div
                    key={i}
                    className={`px-4 py-3 text-sm ${i > 0 ? "border-t border-ink-line-soft" : ""} ${
                      correlated && highlightedActionId === claimedId ? "bg-ink-raised" : ""
                    }`}
                    onMouseEnter={() => correlated && setHighlightedActionId(claimedId!)}
                    onMouseLeave={() => setHighlightedActionId(null)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-on-ink font-medium">{stepLabel(step)}</span>
                      <span className="text-xs text-on-ink-faint font-mono">{formatTime(step.timestamp)}</span>
                    </div>
                    {step.reasoning && <p className="mt-1 text-on-ink-dim">{step.reasoning}</p>}
                    {step.toolArgs !== undefined && (
                      <p className="mt-1 font-mono text-xs text-on-ink-faint break-all">{JSON.stringify(step.toolArgs)}</p>
                    )}
                    {claimedId && (
                      <p className="mt-1 text-xs">
                        {verified ? (
                          <span className="text-accent-bright">
                            → real money action {claimedId.slice(0, 8)} {correlated ? "(paired below)" : ""}
                          </span>
                        ) : (
                          <span className="text-deny-bright">
                            → claimed money action {claimedId.slice(0, 8)}, not found in this merchant&rsquo;s real records
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        </section>

        <section>
          <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-1">This store&rsquo;s decisions</h2>
          <p className="text-sm text-on-ink-dim mb-3">Real audit_log rows — the same bounds every other agent is held to.</p>

          {decisions.length === 0 ? (
            <EmptyState title="No decisions yet" description="Every allow, deny, and escalation will appear here as it happens." />
          ) : (
            <div className="rounded-[var(--radius-lg)] border border-ink-line overflow-hidden max-h-[70vh] overflow-y-auto">
              {decisions.map((entry, i) => {
                const isCorrelated = entry.moneyAction?.id ? verifiedSet.has(entry.moneyAction.id) : false;
                return (
                  <div
                    key={entry.id}
                    className={`px-4 py-3 text-sm ${i > 0 ? "border-t border-ink-line-soft" : ""} ${
                      isCorrelated && highlightedActionId === entry.moneyAction?.id ? "bg-ink-raised" : ""
                    }`}
                    onMouseEnter={() => isCorrelated && setHighlightedActionId(entry.moneyAction!.id)}
                    onMouseLeave={() => setHighlightedActionId(null)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <DecisionBadge decision={asDecision(entry.decision)} compact />
                      <span className="text-xs text-on-ink-faint font-mono">{formatTime(entry.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-on-ink">{entry.reason}</p>
                    {entry.moneyAction && (
                      <p className="mt-1 text-xs text-on-ink-faint font-mono">
                        {entry.moneyAction.type} · {rupees(entry.moneyAction.amountPaise)} · {entry.moneyAction.status}
                        {isCorrelated && <span className="text-accent-bright"> · paired with buyer step</span>}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
