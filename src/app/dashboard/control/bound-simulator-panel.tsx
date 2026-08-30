"use client";

import { useState, useTransition } from "react";
import { runBoundSimulationAction } from "../actions";
import type { BoundSimulationResult } from "@/lib/bound-simulator";
import { formatPaise as rupees } from "@/lib/money";
import { Surface, Select, Field, Input, Button } from "@/components/ui";

interface AgentOption {
  id: string;
  name: string;
  cap: { capPaise: number; perTransactionMaxPaise: number } | null;
}

export function BoundSimulatorPanel({ agents }: { agents: AgentOption[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [result, setResult] = useState<BoundSimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (agents.length === 0) {
    return <Surface variant="raised" className="p-5 text-sm text-on-ink-faint">No active agents yet.</Surface>;
  }

  const selectedAgent = agents.find((a) => a.id === agentId);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const outcome = await runBoundSimulationAction(formData);
      if ("error" in outcome) {
        setError(outcome.error);
        setResult(null);
        return;
      }
      setResult(outcome);
    });
  }

  return (
    <Surface variant="raised" className="p-5">
      <form action={handleSubmit} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="agentId" value={agentId} />
        <div className="w-52">
          <Field label="Agent">
            <Select value={agentId} onChange={(e) => { setAgentId(e.target.value); setResult(null); }}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-32">
          <Field label="Hypothetical cap (₹)">
            <Input name="hypotheticalCapRupees" type="number" step="0.01" min="0" required defaultValue={selectedAgent?.cap ? (selectedAgent.cap.capPaise / 100).toFixed(2) : undefined} />
          </Field>
        </div>
        <div className="w-32">
          <Field label="Per-tx max (₹)">
            <Input name="hypotheticalPerTransactionMaxRupees" type="number" step="0.01" min="0" required defaultValue={selectedAgent?.cap ? (selectedAgent.cap.perTransactionMaxPaise / 100).toFixed(2) : undefined} />
          </Field>
        </div>
        <div className="w-24">
          <Field label="Window (days)">
            <Input name="windowDays" type="number" step="1" min="1" max="90" defaultValue={30} />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={isPending}>
          {isPending ? "Replaying…" : "Simulate"}
        </Button>
      </form>

      {error && <p className="text-sm text-deny-bright mt-3">{error}</p>}

      {result && (
        <div className="mt-5 pt-4 border-t border-ink-line-soft">
          <p className="text-sm text-on-ink">
            Replayed <span className="font-mono text-on-ink">{result.attemptsReplayed}</span> real attempt(s) over the last{" "}
            {result.windowDays} days. If the cap had been{" "}
            <span className="font-mono text-on-ink">{rupees(result.hypotheticalCapPaise)}</span> instead of{" "}
            <span className="font-mono text-on-ink">{result.actualCapPaise !== null ? rupees(result.actualCapPaise) : "no cap"}</span>:
          </p>
          <div className="grid grid-cols-3 gap-4 mt-3">
            <div>
              <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">Recovered</div>
              <div className="font-mono text-xl tabular-nums text-allow-bright mt-1">{result.recoveredCount}</div>
              <div className="text-xs text-on-ink-faint mt-0.5">worth {rupees(result.recoveredAmountPaise)}</div>
            </div>
            <div>
              <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">Still denied by the cap</div>
              <div className="font-mono text-xl tabular-nums text-deny-bright mt-1">{result.stillDeniedCount}</div>
            </div>
            <div>
              <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">Denied for other reasons</div>
              <div className="font-mono text-xl tabular-nums text-on-ink-dim mt-1">{result.nonCapRefusalCount}</div>
              <div className="text-xs text-on-ink-faint mt-0.5">would still refuse — not a cap issue</div>
            </div>
          </div>
          <p className="text-xs text-on-ink-faint mt-3">
            This is replay, not a forecast — a recovered purchase reflects what the deterministic cap arithmetic would have output for a real recorded attempt, never a guess about whether that buyer would still have bought.
          </p>
        </div>
      )}
    </Surface>
  );
}
