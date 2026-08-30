import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getAgentsWithCaps } from "@/lib/dashboard";
import { getFreezeState } from "@/lib/guardian";
import { throwKillSwitchAction } from "../actions";
import { PageHeader, Surface, Button, Field, Input } from "@/components/ui";
import { BoundSimulatorPanel } from "./bound-simulator-panel";
import { TrustScorePanel } from "./trust-score-panel";

/**
 * Layer 25: control surfaces — what a merchant does when they are
 * nervous. Three tools, none of which decide anything: the Kill Switch
 * (the one exception — it IS the merchant deciding, expressed through
 * the existing Guardian bound), the Bound Simulator (replay only, never
 * a forecast), and the Trust Score (a read-layer summary, never a
 * bound — see trust-score.ts's own docstring and
 * trust-score-never-influences-gate.test.ts).
 */
export default async function ControlPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [agents, freezeState] = await Promise.all([getAgentsWithCaps(merchant.id), getFreezeState(merchant.id)]);
  const activeAgents = agents.filter((a) => a.status === "active");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Control surfaces"
        description="What to do when you're nervous about an agent, a cap, or the whole platform. Everything here informs — the Bound Simulator replays real history, the Trust Score summarizes what's already recorded. The Kill Switch is the one exception: it is you deciding, applied instantly across every agent."
      />

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-1">Kill Switch</h2>
        <p className="text-sm text-on-ink-dim mb-3 max-w-[var(--measure)]">
          Suspends every active agent immediately — the same bound the Runtime Guardian already enforces, applied in bulk. Reversible: unfreezing restores each agent to exactly the state it was in before, including one that was already suspended.
        </p>
        {freezeState ? (
          <Surface variant="raised" className="p-5 border-deny/40">
            <p className="text-sm text-deny-bright font-medium">Kill Switch is currently active.</p>
            <p className="text-xs text-on-ink-faint mt-1">Use the banner at the top of any dashboard page to unfreeze.</p>
          </Surface>
        ) : (
          <Surface variant="raised" className="p-5">
            <form action={throwKillSwitchAction} className="flex flex-col gap-3">
              <Field label="Reason" help="Required — recorded in the audit trail alongside every agent that gets suspended.">
                <Input name="reason" type="text" required placeholder="e.g. suspicious activity across multiple agents" />
              </Field>
              <div>
                <Button type="submit" variant="destructive" pendingLabel="Freezing…">
                  Freeze every agent now ({activeAgents.length} active)
                </Button>
              </div>
            </form>
          </Surface>
        )}
      </section>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-1">Bound Simulator</h2>
        <p className="text-sm text-on-ink-dim mb-3 max-w-[var(--measure)]">
          Replays this agent&rsquo;s real recorded attempts against a hypothetical cap, in the order they actually happened — using the exact arithmetic the gate itself runs. This is history replayed, never a forecast: a denied buyer might have retried, bought less, or left, and this never guesses which.
        </p>
        <BoundSimulatorPanel agents={activeAgents.map((a) => ({ id: a.id, name: a.name, cap: a.cap }))} />
      </section>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-1">Trust Score</h2>
        <p className="text-sm text-on-ink-dim mb-3 max-w-[var(--measure)]">
          A summary of an agent&rsquo;s recorded behaviour — completed purchases, refusal rate, Guardian trips, negotiation conduct, account age — every component visible and traceable to a real count. This never touches the gate; it exists to inform you, not to decide anything on its own.
        </p>
        <TrustScorePanel agents={activeAgents.map((a) => ({ id: a.id, name: a.name }))} />
      </section>
    </div>
  );
}
