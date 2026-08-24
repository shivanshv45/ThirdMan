import { redirect } from "next/navigation";
import { getAgentsWithCaps, getAuditTrail, getPendingEscalations } from "@/lib/dashboard";
import { getSessionMerchant } from "@/lib/auth";
import { setSpendCap, revokeAgent, reactivateAgent, approveEscalation, rejectEscalation, logout } from "./actions";

function rupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function DashboardPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [agents, auditTrail, escalations] = await Promise.all([
    getAgentsWithCaps(merchant.id),
    getAuditTrail(merchant.id, 100),
    getPendingEscalations(merchant.id),
  ]);

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{merchant.name}</h1>
          <p className="text-sm text-gray-500">Merchant dashboard — spend caps, escalations, audit trail</p>
        </div>
        <form action={logout}>
          <button type="submit" className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
            Log out
          </button>
        </form>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-3">Agents &amp; caps</h2>
        <div className="space-y-4">
          {agents.length === 0 && <p className="text-sm text-gray-500">No agents yet.</p>}
          {agents.map((agent) => (
            <div key={agent.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{agent.name}</span>{" "}
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      agent.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {agent.status}
                  </span>
                </div>
                <form action={agent.status === "active" ? revokeAgent : reactivateAgent}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <button
                    type="submit"
                    className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                  >
                    {agent.status === "active" ? "Revoke" : "Reactivate"}
                  </button>
                </form>
              </div>

              {agent.cap ? (
                <div className="mt-2 text-sm text-gray-700">
                  <div className="flex gap-4">
                    <span>
                      Spent {rupees(agent.cap.spentPaise)} of {rupees(agent.cap.capPaise)}
                    </span>
                    <span>Remaining {rupees(agent.cap.remainingPaise)}</span>
                    <span>Per-tx max {rupees(agent.cap.perTransactionMaxPaise)}</span>
                    <span className="text-gray-400">({agent.cap.status})</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded h-2 mt-1">
                    <div
                      className="bg-blue-500 h-2 rounded"
                      style={{
                        width: `${Math.min((agent.cap.spentPaise / agent.cap.capPaise) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs text-gray-400">
                    Window ends {formatDate(agent.cap.windowEnd)}
                  </span>
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">No spend cap set — this agent cannot transact.</p>
              )}

              <form action={setSpendCap} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
                <input type="hidden" name="agentId" value={agent.id} />
                <label className="flex flex-col">
                  Cap (₹)
                  <input name="capRupees" type="number" step="0.01" min="0" required className="border rounded px-2 py-1 w-28" />
                </label>
                <label className="flex flex-col">
                  Per-tx max (₹)
                  <input name="perTransactionMaxRupees" type="number" step="0.01" min="0" required className="border rounded px-2 py-1 w-28" />
                </label>
                <label className="flex flex-col">
                  Window (hours)
                  <input name="windowHours" type="number" step="1" min="1" defaultValue={24} required className="border rounded px-2 py-1 w-24" />
                </label>
                <button type="submit" className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">
                  Set cap
                </button>
              </form>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Pending escalations {escalations.length > 0 && `(${escalations.length})`}
        </h2>
        {escalations.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing pending review.</p>
        ) : (
          <div className="space-y-3">
            {escalations.map((esc) => (
              <div key={esc.id} className="border border-amber-300 bg-amber-50 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">
                      {esc.agent?.name ?? "Unknown agent"} — {rupees(esc.moneyAction.amountPaise)}
                    </span>
                    <span className="text-xs text-gray-500 ml-2">{formatDate(esc.createdAt)}</span>
                  </div>
                  <div className="flex gap-2">
                    <form action={approveEscalation}>
                      <input type="hidden" name="escalationId" value={esc.id} />
                      <button type="submit" className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700">
                        Approve
                      </button>
                    </form>
                    <form action={rejectEscalation}>
                      <input type="hidden" name="escalationId" value={esc.id} />
                      <button type="submit" className="text-sm px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700">
                        Reject
                      </button>
                    </form>
                  </div>
                </div>
                <p className="text-sm text-gray-700 mt-1">{esc.riskReason}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Audit trail</h2>
        <div className="space-y-1">
          {auditTrail.length === 0 && <p className="text-sm text-gray-500">No entries yet.</p>}
          {auditTrail.map((entry) => (
            <div
              key={entry.id}
              className={`border-l-4 pl-3 py-2 text-sm ${
                entry.decision === "allow"
                  ? "border-green-500"
                  : entry.decision === "deny"
                    ? "border-red-500"
                    : entry.decision === "escalate"
                      ? "border-amber-500"
                      : "border-gray-300"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-semibold uppercase ${
                    entry.decision === "allow"
                      ? "text-green-700"
                      : entry.decision === "deny"
                        ? "text-red-700"
                        : entry.decision === "escalate"
                          ? "text-amber-700"
                          : "text-gray-500"
                  }`}
                >
                  {entry.decision}
                </span>
                <span className="text-xs text-gray-400">{entry.event}</span>
                <span className="text-xs text-gray-400 ml-auto">{formatDate(entry.createdAt)}</span>
              </div>
              <p className="text-gray-800">{entry.reason}</p>
              {entry.boundApplied && (
                <p className="text-xs text-gray-500">Bound: {entry.boundApplied}</p>
              )}
              {entry.moneyAction && (
                <p className="text-xs text-gray-500">
                  {entry.moneyAction.type} — {rupees(entry.moneyAction.amountPaise)} — {entry.moneyAction.status}
                  {entry.moneyAction.razorpayEntityId && ` — ${entry.moneyAction.razorpayEntityId}`}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
