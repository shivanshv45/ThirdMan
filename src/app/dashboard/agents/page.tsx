import { redirect } from "next/navigation";
import { getAgentsWithCaps } from "@/lib/dashboard";
import { getSessionMerchant } from "@/lib/auth";
import { setSpendCap, revokeAgent, reactivateAgent, setAgentCapabilities } from "../actions";
import { CreateAgentForm, RotateKeyButton, MandateRequiredToggle } from "../agent-key-reveal";
import { formatPaise as rupees } from "@/lib/money";
import { PageHeader, Surface, Button, Field, Input, EmptyState, DetailsToggle } from "@/components/ui";
import { schema } from "@/lib/db";

const CAPABILITY_LABELS: Record<(typeof schema.agentCapabilityEnum.enumValues)[number], string> = {
  "products:read": "Read the catalogue",
  "policy:read": "Read return/refund policy",
  "offers:read": "Read upsell offers",
  "rewards:read": "Read reward-coin balance",
  "rewards:redeem": "Redeem reward coins",
  "negotiation:create": "Negotiate a price",
  "purchase:create": "Make a purchase",
};

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
        <div className="space-y-3">
          {agents.map((agent) => {
            const pct = agent.cap ? Math.min((agent.cap.spentPaise / agent.cap.capPaise) * 100, 100) : 0;
            const revoked = agent.status !== "active";
            // The bar carries the cap's own real status, not an invented
            // threshold — "exhausted" is a value the gate actually wrote.
            const barColor = agent.cap?.status === "exhausted" ? "var(--deny)" : "var(--accent)";

            return (
              <Surface key={agent.id} variant="raised" className={`p-5 ${revoked ? "opacity-70" : ""}`}>
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-[var(--t-h4)] font-medium text-on-ink truncate">{agent.name}</span>
                    <span
                      className={`text-[var(--t-label)] uppercase tracking-[0.06em] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                        agent.status === "active"
                          ? "bg-allow-wash text-allow-bright"
                          : "bg-ink-overlay text-on-ink-faint"
                      }`}
                    >
                      {agent.status}
                    </span>
                    {agent.registrationSource === "self_registered" && (
                      <span className="text-[var(--t-label)] uppercase tracking-[0.06em] px-2 py-0.5 rounded-full font-medium shrink-0 bg-accent-wash text-accent">
                        Self-registered
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
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
                  <div className="mt-4">
                    <div className="flex items-end justify-between gap-4 flex-wrap">
                      <div>
                        <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">
                          Remaining this window
                        </div>
                        <div className="mt-1 font-mono text-2xl tabular-nums text-on-ink leading-none">
                          {rupees(agent.cap.remainingPaise)}
                        </div>
                      </div>
                      <div className="text-xs font-mono tabular-nums text-on-ink-dim text-right">
                        <div>
                          {rupees(agent.cap.spentPaise)} spent of {rupees(agent.cap.capPaise)}
                        </div>
                        <div className="text-on-ink-faint mt-0.5">
                          {rupees(agent.cap.perTransactionMaxPaise)} max per transaction
                        </div>
                      </div>
                    </div>

                    <div className="w-full bg-ink-overlay rounded-full h-1 mt-3 overflow-hidden">
                      <div
                        className="h-1 rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                        style={{ width: `${pct}%`, background: barColor }}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-2 text-xs font-mono text-on-ink-faint">
                      <span>Window ends {formatDate(agent.cap.windowEnd)}</span>
                      <span>{agent.cap.status}</span>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-deny-bright">
                    No spend cap set — this agent cannot transact.
                  </p>
                )}

                {/* Collapsed by default: the card should lead with what the
                    cap currently is, not with three empty inputs asking to
                    change it. */}
                <div className="mt-4 pt-4 border-t border-ink-line-soft">
                  <DetailsToggle summary={agent.cap ? "Change cap" : "Set a cap"} variant="plain">
                    <form action={setSpendCap} className="flex flex-wrap items-end gap-2">
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
                        {agent.cap ? "Update cap" : "Set cap"}
                      </Button>
                    </form>
                  </DetailsToggle>
                </div>

                {/* Layer 13-2: authentication is not authorization — an
                    agent holds only what's checked here, regardless of its
                    spend cap. Deny by default: a new agent starts with
                    none checked. */}
                <div className="mt-3 pt-3 border-t border-ink-line-soft">
                  <DetailsToggle
                    summary={`Capabilities (${agent.capabilities.length} of ${Object.keys(CAPABILITY_LABELS).length} granted)`}
                    variant="plain"
                  >
                    <form action={setAgentCapabilities} className="flex flex-col gap-2">
                      <input type="hidden" name="agentId" value={agent.id} />
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {Object.entries(CAPABILITY_LABELS).map(([capability, label]) => (
                          <label key={capability} className="flex items-center gap-2 text-sm text-on-ink-dim">
                            <input
                              type="checkbox"
                              name="capabilities"
                              value={capability}
                              defaultChecked={agent.capabilities.includes(capability as (typeof schema.agentCapabilityEnum.enumValues)[number])}
                              className="accent-[var(--accent)]"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      <div>
                        <Button type="submit" variant="secondary" size="sm" pendingLabel="Saving…">
                          Save capabilities
                        </Button>
                      </div>
                    </form>
                  </DetailsToggle>
                </div>

                {/* Layer 13-3: opt-in AP2 mandate requirement per agent —
                    off by default so existing demo flows keep working. */}
                <div className="mt-3 pt-3 border-t border-ink-line-soft">
                  <MandateRequiredToggle agentId={agent.id} defaultChecked={agent.mandateRequired} />
                </div>

                {/* Layer 21-4: proof of agency — "who authorized this and
                    how do I prove it," per purchase. An honest empty state
                    when this agent has never presented a mandate, never an
                    ambiguous or missing section that could read as
                    "verified." */}
                <div className="mt-3 pt-3 border-t border-ink-line-soft">
                  <DetailsToggle summary={`Proof of agency (${agent.mandateBackedPurchases.length} mandate-backed purchase${agent.mandateBackedPurchases.length === 1 ? "" : "s"})`} variant="plain">
                    {agent.mandateBackedPurchases.length === 0 ? (
                      <p className="text-sm text-on-ink-faint">
                        No purchase from this agent has ever presented a verified AP2 Payment Mandate. This is the common case while mandates are opt-in — it does not mean anything went wrong.
                      </p>
                    ) : (
                      <ul className="space-y-1.5 text-xs font-mono text-on-ink-dim">
                        {agent.mandateBackedPurchases.map((p) => (
                          <li key={p.moneyActionId} className="flex justify-between gap-3">
                            <span className="text-on-ink-faint">{formatDate(p.createdAt)}</span>
                            <span>{rupees(p.amountPaise)}</span>
                            <span className="text-on-ink-faint">{p.status}</span>
                            <span className="text-on-ink-faint truncate" title={p.mandateId}>mandate {p.mandateId.slice(0, 8)}…</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </DetailsToggle>
                </div>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
