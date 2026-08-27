"use client";

import { useState, useTransition } from "react";
import { explainDecisionAction } from "./actions";
import type { UnifiedDecision } from "@/lib/explainability";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const kindStyles: Record<string, { borderColor: string; text: string; label: string }> = {
  refusal: { borderColor: "var(--deny)", text: "text-deny-bright", label: "Refused" },
  deferral: { borderColor: "var(--escalate)", text: "text-escalate-bright", label: "Deferred to you" },
};

const sourceLabels: Record<string, string> = {
  gate: "Gate",
  offer_engine: "Offer engine",
  recovery: "Recovery",
  risk_escalation: "Risk escalation",
  negotiation: "Negotiation",
};

export function DecisionList({ decisions }: { decisions: UnifiedDecision[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ul className="space-y-2">
      {decisions.map((d) => {
        const style = kindStyles[d.kind];
        const isExpanded = expandedId === d.id;
        return (
          <li
            key={d.id}
            className="rounded-r-[var(--radius-lg)] bg-ink-raised border border-ink-line px-4 py-3"
            style={{ borderLeftColor: style.borderColor, borderLeftWidth: "3px" }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className={`font-medium ${style.text}`}>{style.label}</span>
                  <span className="text-on-ink-faint">·</span>
                  <span className="text-on-ink-dim">{sourceLabels[d.source] ?? d.source}</span>
                  <span className="text-on-ink-faint">·</span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-medium ${
                      d.determinism === "deterministic"
                        ? "bg-allow-wash text-allow-bright"
                        : "bg-accent-wash text-accent-bright"
                    }`}
                  >
                    {d.determinism === "deterministic" ? "Arithmetic, no model" : "A model's judgment"}
                  </span>
                </div>
                <div className="font-medium text-sm mt-1.5 text-on-ink">{d.boundLabel}</div>
                <p className="text-sm text-on-ink-dim mt-1">{d.reason}</p>
                {d.arithmetic.length > 0 && (
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
                    {d.arithmetic.map((a) => (
                      <div key={a.label} className="flex gap-1">
                        <dt className="text-on-ink-faint">{a.label}:</dt>
                        <dd className="font-mono text-on-ink">{a.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
              <span className="text-xs text-on-ink-faint whitespace-nowrap font-mono">{formatDate(d.createdAt)}</span>
            </div>

            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : d.id)}
              className="text-xs text-accent hover:text-accent-bright mt-2 transition-colors"
            >
              {isExpanded ? "Hide details" : "Show details"}
            </button>

            {isExpanded && <ExpandedDetails decision={d} />}
          </li>
        );
      })}
    </ul>
  );
}

function ExpandedDetails({ decision }: { decision: UnifiedDecision }) {
  const [explanation, setExplanation] = useState<{ text: string; available: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleExplain() {
    startTransition(async () => {
      const result = await explainDecisionAction(decision.id);
      setExplanation({ text: result.explanation, available: result.available });
    });
  }

  return (
    <div className="mt-3 pt-3 border-t border-ink-line-soft text-xs text-on-ink-dim space-y-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
        <div>
          Source table: <span className="text-on-ink">{decision.sourceRef.table}</span>
        </div>
        <div>
          Row id: <span className="text-on-ink">{decision.sourceRef.id}</span>
        </div>
        {decision.boundRaw && (
          <div>
            Raw bound: <span className="text-on-ink">{decision.boundRaw}</span>
          </div>
        )}
        {decision.agentName && <div className="font-sans">Agent: {decision.agentName}</div>}
        {decision.sessionToken && (
          <div>
            Session: <span className="text-on-ink">{decision.sessionToken.slice(0, 12)}…</span>
          </div>
        )}
      </div>

      {!explanation && (
        <button
          type="button"
          onClick={handleExplain}
          disabled={isPending}
          className="text-xs px-2.5 py-1.5 rounded-[var(--radius)] bg-ink-overlay border border-ink-line text-on-ink hover:border-on-ink-faint disabled:opacity-50 transition-colors font-sans inline-flex items-center gap-1.5"
        >
          {isPending && <span className="h-2.5 w-2.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />}
          {isPending ? "Asking…" : "Explain this in plain language"}
        </button>
      )}

      {explanation && (
        <div className="bg-accent-wash border border-accent/25 rounded-[var(--radius)] px-3 py-2 font-sans">
          <div className="text-accent-bright font-medium mb-1 text-xs">
            {explanation.available ? "Generated explanation" : "Explanation unavailable"}
          </div>
          {explanation.available ? (
            <p className="text-on-ink-dim">{explanation.text}</p>
          ) : (
            <p className="text-on-ink-faint">
              The plain-language explainer is unavailable right now. The recorded reason above is the complete record — it hasn&apos;t changed and doesn&apos;t need the explainer to be trusted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
