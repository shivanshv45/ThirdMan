"use client";

import { useState, useTransition } from "react";
import { explainDecisionAction } from "./actions";
import type { UnifiedDecision } from "@/lib/explainability";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const kindStyles: Record<string, { border: string; text: string; label: string }> = {
  refusal: { border: "border-red-500", text: "text-red-700", label: "Refused" },
  deferral: { border: "border-amber-500", text: "text-amber-700", label: "Deferred to you" },
};

const sourceLabels: Record<string, string> = {
  gate: "Gate",
  offer_engine: "Offer engine",
  recovery: "Recovery",
  risk_escalation: "Risk escalation",
};

export function DecisionList({ decisions }: { decisions: UnifiedDecision[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ul className="space-y-2">
      {decisions.map((d) => {
        const style = kindStyles[d.kind];
        const isExpanded = expandedId === d.id;
        return (
          <li key={d.id} className={`border-l-4 ${style.border} bg-white border rounded-r px-4 py-3`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={`font-medium ${style.text}`}>{style.label}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500">{sourceLabels[d.source]}</span>
                  <span className="text-gray-400">·</span>
                  <span className={d.determinism === "deterministic" ? "text-gray-500" : "text-indigo-600"}>
                    {d.determinism === "deterministic" ? "Arithmetic, no model" : "A model's judgment"}
                  </span>
                </div>
                <div className="font-medium text-sm mt-1">{d.boundLabel}</div>
                <p className="text-sm text-gray-700 mt-1">{d.reason}</p>
                {d.arithmetic.length > 0 && (
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
                    {d.arithmetic.map((a) => (
                      <div key={a.label} className="flex gap-1">
                        <dt>{a.label}:</dt>
                        <dd className="font-medium text-gray-700">{a.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
              <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(d.createdAt)}</span>
            </div>

            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : d.id)}
              className="text-xs text-gray-500 underline mt-2"
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
    <div className="mt-3 pt-3 border-t text-xs text-gray-500 space-y-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <div>Source table: <span className="font-mono">{decision.sourceRef.table}</span></div>
        <div>Row id: <span className="font-mono">{decision.sourceRef.id}</span></div>
        {decision.boundRaw && <div>Raw bound: <span className="font-mono">{decision.boundRaw}</span></div>}
        {decision.agentName && <div>Agent: {decision.agentName}</div>}
        {decision.sessionToken && <div>Session: <span className="font-mono">{decision.sessionToken.slice(0, 12)}…</span></div>}
      </div>

      {!explanation && (
        <button
          type="button"
          onClick={handleExplain}
          disabled={isPending}
          className="text-xs px-2 py-1 rounded border hover:bg-gray-50 disabled:opacity-50"
        >
          {isPending ? "Asking…" : "Explain this in plain language"}
        </button>
      )}

      {explanation && (
        <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2">
          <div className="text-indigo-700 font-medium mb-1">
            {explanation.available ? "Generated explanation" : "Explanation unavailable"}
          </div>
          {explanation.available ? (
            <p className="text-gray-700">{explanation.text}</p>
          ) : (
            <p className="text-gray-500">
              The plain-language explainer is unavailable right now. The recorded reason above is the complete record — it hasn&apos;t changed and doesn&apos;t need the explainer to be trusted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
