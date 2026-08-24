import { redirect } from "next/navigation";
import Link from "next/link";
import { getAgentsWithCaps, getAuditTrail, getPendingEscalations, getRazorpayConnectionStatus } from "@/lib/dashboard";
import { getSessionMerchant } from "@/lib/auth";
import { setSpendCap, revokeAgent, reactivateAgent, approveEscalation, rejectEscalation } from "./actions";
import { CreateAgentForm, RotateKeyButton } from "./agent-key-reveal";
import { AuditTrail } from "./audit-trail";
import { formatPaise as rupees } from "@/lib/money";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function DashboardPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [agents, auditTrail, escalations, razorpayStatus] = await Promise.all([
    getAgentsWithCaps(merchant.id),
    getAuditTrail(merchant.id, 100),
    getPendingEscalations(merchant.id),
    getRazorpayConnectionStatus(merchant.id),
  ]);

  const hasAgentWithCap = agents.some((a) => a.cap !== null);
  const isFirstRun = !razorpayStatus.connected || agents.length === 0 || !hasAgentWithCap;

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-gray-500">Spend caps, escalations, and the audit trail</p>
      </header>

      {isFirstRun && (
        <section className="border border-blue-200 bg-blue-50 rounded-lg p-5">
          <h2 className="font-semibold mb-3">Get set up</h2>
          <ol className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <span className={razorpayStatus.connected ? "text-green-600" : "text-gray-400"}>
                {razorpayStatus.connected ? "✓" : "○"}
              </span>
              {razorpayStatus.connected ? (
                <span>Connected to Razorpay ({razorpayStatus.maskedKeyId})</span>
              ) : (
                <span>
                  <Link href="/dashboard/settings" className="text-blue-700 underline">
                    Connect your Razorpay test account
                  </Link>{" "}
                  — every purchase settles into your own account, not a shared one.
                </span>
              )}
            </li>
            <li className="flex items-center gap-2">
              <span className={agents.length > 0 ? "text-green-600" : "text-gray-400"}>
                {agents.length > 0 ? "✓" : "○"}
              </span>
              <span>Create an agent below — it gets its own API key an AI buyer authenticates with.</span>
            </li>
            <li className="flex items-center gap-2">
              <span className={hasAgentWithCap ? "text-green-600" : "text-gray-400"}>
                {hasAgentWithCap ? "✓" : "○"}
              </span>
              <span>Set a spend cap on that agent — no cap means it can never transact.</span>
            </li>
          </ol>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Agents &amp; caps</h2>

        <div className="mb-4">
          <CreateAgentForm />
        </div>

        <div className="space-y-4">
          {agents.length === 0 && (
            <p className="text-sm text-gray-500">
              No agents yet — create one above to give an AI buyer a scoped API key and spend cap.
            </p>
          )}
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
                <div className="flex items-center gap-2">
                  <RotateKeyButton agentId={agent.id} />
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

      <AuditTrail initialEntries={auditTrail} />
    </main>
  );
}
