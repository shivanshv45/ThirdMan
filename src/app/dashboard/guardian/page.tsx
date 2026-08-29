import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getGuardianIncidents, getGuardianTransitions } from "@/lib/dashboard";
import { rearmAgentAction } from "../actions";
import { PageHeader, Surface, Button, EmptyState, DecisionBadge } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Layer 13-4: the Guardian incident view — is this agent behaving
 * normally right now, and if not, exactly which signal tripped and
 * against what baseline. Every row here reflects a real state written
 * by guardian.ts's evaluateAndTransition, never an invented threshold.
 */
export default async function GuardianPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const incidents = await getGuardianIncidents(merchant.id);
  const transitionsByAgent = await Promise.all(
    incidents.map(async (incident) => ({
      agentId: incident.agentId,
      transitions: await getGuardianTransitions(merchant.id, incident.agentId),
    })),
  );
  const transitionsMap = new Map(transitionsByAgent.map((t) => [t.agentId, t.transitions]));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Runtime Guardian"
        description="Authentication and a spend cap answer whether a transaction is allowed. This answers a different question: is this agent behaving normally right now. Every signal below is arithmetic against this agent's own rolling baseline, computed in SQL — no model is ever consulted for this judgment. A suspended agent is denied at the gate itself, before its spend cap is even checked."
      />

      {incidents.length === 0 ? (
        <EmptyState
          title="No open incidents"
          description="Every active agent is within its own normal operating baseline. This page only shows agents currently throttled or suspended."
        />
      ) : (
        <div className="space-y-3">
          {incidents.map((incident) => {
            const transitions = transitionsMap.get(incident.agentId) ?? [];
            return (
              <Surface key={incident.agentId} variant="raised" className="p-5">
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-[var(--t-h4)] font-medium text-on-ink truncate">{incident.agentName}</span>
                    <DecisionBadge decision={incident.state === "suspended" ? "deny" : "escalate"} label={incident.state} compact />
                  </div>
                  <form action={rearmAgentAction}>
                    <input type="hidden" name="agentId" value={incident.agentId} />
                    <Button type="submit" variant="secondary" size="sm" pendingLabel="Re-arming…">
                      Re-arm to normal
                    </Button>
                  </form>
                </div>

                <p className="mt-3 text-sm text-on-ink-dim">
                  Tripped on <span className="font-mono text-on-ink">{incident.lastSignal}</span>: observed{" "}
                  <span className="font-mono text-on-ink">{incident.lastObservedValue}</span> against a baseline of{" "}
                  <span className="font-mono text-on-ink">{incident.lastBaselineValue ?? "n/a"}</span>.
                </p>
                <p className="mt-1 text-xs text-on-ink-faint">Last updated {formatDate(incident.updatedAt)}.</p>

                {transitions.length > 0 && (
                  <details className="mt-4 pt-4 border-t border-ink-line-soft group">
                    <summary className="cursor-pointer text-sm text-on-ink-dim hover:text-on-ink">
                      Transition history ({transitions.length})
                    </summary>
                    <div className="mt-3 space-y-2">
                      {transitions.map((t) => (
                        <div key={t.id} className="flex items-center justify-between gap-3 text-xs font-mono text-on-ink-faint">
                          <span>
                            {t.fromState} → {t.toState} ({t.triggerSignal})
                          </span>
                          <span>{formatDate(t.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
