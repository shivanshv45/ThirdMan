"use client";

import { useActionState } from "react";
import { runPreflightSimulation } from "../actions";
import { Button, Field, Input, Select, DecisionBadge, Surface } from "@/components/ui";

type SimulationState = { decision: "allow" | "deny" | "escalate"; reason: string; agentName: string } | { error: string } | null;

async function submit(_prev: SimulationState, formData: FormData): Promise<SimulationState> {
  try {
    const result = await runPreflightSimulation(formData);
    return { decision: result.decision, reason: result.reason, agentName: result.agentName };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not run the simulation." };
  }
}

/**
 * Layer 13-5: "what happens if this agent tries ₹X" — a real question
 * answered by the real gate (attemptMoneyAction with dryRun: true, via
 * runPreflightSimulation), not a guess. Nothing here is executed or
 * reserved regardless of the outcome shown.
 */
export function PreflightForm({ agents }: { agents: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<SimulationState, FormData>(submit, null);

  return (
    <Surface variant="raised" className="p-6 space-y-5">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label="Agent">
            <Select name="agentId" required defaultValue="">
              <option value="" disabled>
                Choose an agent…
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-32">
          <Field label="Amount (₹)">
            <Input name="amountRupees" type="number" step="0.01" min="0" required />
          </Field>
        </div>
        <div className="w-64">
          <Field label="Context (optional)">
            <Input name="context" placeholder="e.g. bulk restock order" />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={pending || agents.length === 0} pendingLabel="Simulating…">
          Run preflight
        </Button>
      </form>

      {agents.length === 0 && <p className="text-sm text-on-ink-faint">Create an agent first on the Agents page.</p>}

      {state && (
        <div className="pt-4 border-t border-ink-line-soft">
          {"error" in state ? (
            <p className="text-sm text-deny-bright">{state.error}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <DecisionBadge decision={state.decision} />
                <span className="text-sm text-on-ink-dim">for &quot;{state.agentName}&quot;</span>
              </div>
              <p className="text-sm text-on-ink-dim">{state.reason}</p>
              <p className="text-xs text-on-ink-faint">Nothing was reserved or executed. This simulation ran through the exact same checks a real purchase attempt would.</p>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}
