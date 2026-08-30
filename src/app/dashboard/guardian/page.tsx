import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getGuardianIncidents, getGuardianTransitions, getAgentReadPurchaseRatios } from "@/lib/dashboard";
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

  const readRatios = await getAgentReadPurchaseRatios(merchant.id);

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

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-1">Shopping vs. buying</h2>
        <p className="text-sm text-on-ink-dim mb-3 max-w-[var(--measure)]">
          An agent that reads your catalogue far more than it buys isn&rsquo;t necessarily wrong — thorough comparison shopping looks the same as a competitor scraping prices until you see the ratio. This is information, not a bound: nothing here blocks a request automatically. Act on it by revoking a key or tightening its capabilities in Agents &amp; caps.
        </p>
        {readRatios.length === 0 ? (
          <EmptyState title="No active agents yet" description="This section fills in once at least one agent has made a catalogue read." />
        ) : (
          <div className="space-y-2">
            {readRatios.map((row) => (
              <Surface key={row.agentId} variant="raised" className={`p-3.5 flex items-center justify-between flex-wrap gap-2 ${row.lopsided ? "border-escalate/40" : ""}`}>
                <span className="font-medium text-on-ink truncate">{row.agentName}</span>
                <div className="flex items-center gap-4 text-xs font-mono text-on-ink-faint">
                  <span>{row.catalogueReadCount} reads</span>
                  <span>{row.purchaseCount} purchases</span>
                  <span className={row.lopsided ? "text-escalate-bright font-medium" : "text-on-ink-dim"}>
                    {row.ratio === null ? (row.catalogueReadCount > 0 ? "never purchased" : "n/a") : `${row.ratio.toFixed(1)}:1`}
                  </span>
                  {row.lopsided && <DecisionBadge decision="escalate" label="worth reviewing" compact />}
                </div>
              </Surface>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
