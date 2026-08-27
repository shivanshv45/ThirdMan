import { redirect } from "next/navigation";
import { getAgentsWithCaps } from "@/lib/dashboard";
import { getSessionMerchant } from "@/lib/auth";
import { setSpendCap, revokeAgent, reactivateAgent } from "../actions";
import { CreateAgentForm, RotateKeyButton } from "../agent-key-reveal";
import { formatPaise as rupees } from "@/lib/money";
import { PageHeader, Surface, Button, Field, Input, EmptyState } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function AgentsPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const agents = await getAgentsWithCaps(merchant.id);

  return (
    <div>
      <PageHeader
        title="Agents & caps"
        description="Each AI buyer authenticates with its own key and transacts only within the spend cap you set here. No cap means it can never move money."
        actions={<CreateAgentForm />}
      />

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Create one above to give an AI buyer a scoped API key and spend cap."
        />
      ) : (
        <div className="space-y-4">
          {agents.map((agent) => {
            const pct = agent.cap ? Math.min((agent.cap.spentPaise / agent.cap.capPaise) * 100, 100) : 0;
            return (
              <Surface key={agent.id} variant="raised" className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-on-ink">{agent.name}</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        agent.status === "active"
                          ? "bg-allow-wash text-allow-bright"
                          : "bg-ink-overlay text-on-ink-faint"
                      }`}
                    >
                      {agent.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <RotateKeyButton agentId={agent.id} />
                    <form action={agent.status === "active" ? revokeAgent : reactivateAgent}>
                      <input type="hidden" name="agentId" value={agent.id} />
                      <Button type="submit" size="sm" variant={agent.status === "active" ? "destructive" : "secondary"}>
                        {agent.status === "active" ? "Revoke" : "Reactivate"}
                      </Button>
                    </form>
                  </div>
                </div>

                {agent.cap ? (
                  <div className="mt-3 text-sm">
                    <div className="flex gap-4 font-mono tabular-nums text-on-ink-dim text-xs">
                      <span>
                        Spent <span className="text-on-ink">{rupees(agent.cap.spentPaise)}</span> of{" "}
                        {rupees(agent.cap.capPaise)}
                      </span>
                      <span>Remaining {rupees(agent.cap.remainingPaise)}</span>
                      <span>Per-tx max {rupees(agent.cap.perTransactionMaxPaise)}</span>
                      <span className="text-on-ink-faint">({agent.cap.status})</span>
                    </div>
                    <div className="w-full bg-ink-overlay rounded-full h-1.5 mt-2">
                      <div
                        className="bg-accent h-1.5 rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-on-ink-faint font-mono">
                      Window ends {formatDate(agent.cap.windowEnd)}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-on-ink-dim">No spend cap set — this agent cannot transact.</p>
                )}

                <form action={setSpendCap} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="agentId" value={agent.id} />
                  <div className="w-28">
                    <Field label="Cap (₹)">
                      <Input name="capRupees" type="number" step="0.01" min="0" required />
                    </Field>
                  </div>
                  <div className="w-28">
                    <Field label="Per-tx max (₹)">
                      <Input name="perTransactionMaxRupees" type="number" step="0.01" min="0" required />
                    </Field>
                  </div>
                  <div className="w-24">
                    <Field label="Window (h)">
                      <Input name="windowHours" type="number" step="1" min="1" defaultValue={24} required />
                    </Field>
                  </div>
                  <Button type="submit" variant="primary" pendingLabel="Setting…">
                    Set cap
                  </Button>
                </form>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
