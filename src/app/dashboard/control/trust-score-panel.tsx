"use client";

import { useState, useTransition } from "react";
import { getTrustScoreAction } from "../actions";
import type { TrustReport } from "@/lib/trust-score";
import { Surface, Select, Button } from "@/components/ui";

export function TrustScorePanel({ agents }: { agents: { id: string; name: string }[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [report, setReport] = useState<TrustReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (agents.length === 0) {
    return <Surface variant="raised" className="p-5 text-sm text-on-ink-faint">No active agents yet.</Surface>;
  }

  function handleLoad() {
    setError(null);
    startTransition(async () => {
      const result = await getTrustScoreAction(agentId);
      if ("error" in result) {
        setError(result.error);
        setReport(null);
        return;
      }
      setReport(result);
    });
  }

  return (
    <Surface variant="raised" className="p-5">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-56">
          <Select value={agentId} onChange={(e) => { setAgentId(e.target.value); setReport(null); }}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="button" variant="secondary" onClick={handleLoad} disabled={isPending}>
          {isPending ? "Computing…" : "Show trust score"}
        </Button>
      </div>

      {error && <p className="text-sm text-deny-bright mt-3">{error}</p>}

      {report && (
        <div className="mt-5">
          <div className="flex items-center gap-4">
            <div className="font-mono text-4xl tabular-nums text-on-ink leading-none">{report.score}</div>
            <div className="text-xs text-on-ink-faint">out of 100</div>
            {report.thinEvidence && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-escalate-wash text-escalate-bright font-medium">
                Thin evidence — only {report.completedPurchaseCount} completed purchase{report.completedPurchaseCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <div className="mt-4 space-y-2">
            {report.components.map((c) => (
              <div key={c.id} className="flex items-center gap-3">
                <div className="w-44 shrink-0 text-xs text-on-ink-dim">{c.label}</div>
                <div className="flex-1 h-1.5 rounded-full bg-ink-overlay overflow-hidden min-w-[3rem]">
                  <div className="h-full bg-accent" style={{ width: `${Math.round(c.score * 100)}%` }} />
                </div>
                <div className="w-10 shrink-0 text-right text-xs font-mono text-on-ink-faint">{Math.round(c.score * 100)}%</div>
                <div className="w-10 shrink-0 text-right text-xs font-mono text-on-ink-faint">{c.weight}pt</div>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1">
            {report.components.map((c) => (
              <p key={c.id} className="text-xs text-on-ink-faint">
                {c.detail}
              </p>
            ))}
          </div>
        </div>
      )}
    </Surface>
  );
}
