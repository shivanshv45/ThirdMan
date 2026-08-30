import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getAuditTrail,
  getPendingEscalations,
  getRazorpayConnectionStatus,
  getAgentsWithCaps,
  getMoneyMovedStats,
  getDecisionCounts,
  getMoneyAtRiskSummary,
} from "@/lib/dashboard";
import { getRecoveryStats } from "@/lib/recovery/attribution";
import { getDecisionStats } from "@/lib/explainability";
import { getSessionMerchant } from "@/lib/auth";
import { approveEscalation, rejectEscalation } from "./actions";
import { AuditTrail } from "./audit-trail";
import { formatPaise as rupees } from "@/lib/money";
import { PageHeader, Surface, MoneyStat, Stat, Button, DecisionComposition } from "@/components/ui";
import { MoneyAtRisk } from "./money-at-risk";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function DashboardPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [auditTrail, escalations, razorpayStatus, agents, moneyMoved, decisionCounts, recoveryStats, decisionStats, moneyAtRisk] =
    await Promise.all([
      getAuditTrail(merchant.id, 100),
      getPendingEscalations(merchant.id),
      getRazorpayConnectionStatus(merchant.id),
      getAgentsWithCaps(merchant.id),
      getMoneyMovedStats(merchant.id),
      getDecisionCounts(merchant.id),
      getRecoveryStats(merchant.id),
      getDecisionStats(merchant.id),
      getMoneyAtRiskSummary(merchant.id),
    ]);

  const hasAgentWithCap = agents.some((a) => a.cap !== null);
  const isFirstRun = !razorpayStatus.connected || agents.length === 0 || !hasAgentWithCap;

  return (
    <div>
      <PageHeader
        title="Overview"
      />

      {isFirstRun && (
        <Surface variant="raised" className="relative overflow-hidden p-6 mb-12">
          <span aria-hidden="true" className="absolute left-0 inset-y-0 w-[3px] bg-accent" />
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Get set up</h2>
          <p className="text-sm text-on-ink-dim mt-1 mb-4">
            Three steps before an agent can move any money. Nothing transacts until all three are done.
          </p>
          <ol className="space-y-3 text-sm">
            <li className="flex items-center gap-2.5">
              <StepMark done={razorpayStatus.connected} />
              {razorpayStatus.connected ? (
                <span className="text-on-ink-dim">
                  Connected to Razorpay <span className="font-mono text-xs">({razorpayStatus.maskedKeyId})</span>
                </span>
              ) : (
                <span className="text-on-ink-dim">
                  <Link href="/dashboard/settings" className="text-accent hover:text-accent-bright underline underline-offset-2">
                    Connect your Razorpay test account
                  </Link>{" "}
                  — every purchase settles into your own account, not a shared one.
                </span>
              )}
            </li>
            <li className="flex items-center gap-2.5">
              <StepMark done={agents.length > 0} />
              <span className="text-on-ink-dim">
                <Link href="/dashboard/agents" className="text-accent hover:text-accent-bright underline underline-offset-2">
                  Create an agent
                </Link>{" "}
                — it gets its own API key an AI buyer authenticates with.
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <StepMark done={hasAgentWithCap} />
              <span className="text-on-ink-dim">Set a spend cap on that agent — no cap means it can never transact.</span>
            </li>
          </ol>
        </Surface>
      )}

      {escalations.length > 0 && (
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-on-ink tracking-tight">
              Tasks
            </h2>
            <span className="text-xs font-medium text-escalate-bright px-2 py-0.5 bg-escalate-wash rounded-full">
              {escalations.length} to review
            </span>
          </div>
          <Surface className="divide-y divide-ink-line-soft overflow-hidden">
            {escalations.map((esc) => (
              <div
                key={esc.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-ink-overlay transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-lg font-medium text-on-ink tabular-nums">
                      {rupees(esc.moneyAction.amountPaise)}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-ink-line-soft text-xs font-medium text-on-ink-dim">
                      {esc.agent?.name ?? "Unknown agent"}
                    </span>
                  </div>
                  <p className="text-sm text-on-ink-dim mt-1 max-w-2xl truncate">{esc.riskReason}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <form action={approveEscalation}>
                    <input type="hidden" name="escalationId" value={esc.id} />
                    <Button type="submit" variant="primary" size="sm" pendingLabel="Approving…">
                      Approve
                    </Button>
                  </form>
                  <form action={rejectEscalation}>
                    <input type="hidden" name="escalationId" value={esc.id} />
                    <Button type="submit" variant="destructive" size="sm" pendingLabel="Rejecting…">
                      Reject
                    </Button>
                  </form>
                </div>
              </div>
            ))}
          </Surface>
        </section>
      )}

      <MoneyAtRisk summary={moneyAtRisk} />

      {/* The two headline facts, given the room that says so. Everything
          below this band is supporting evidence and renders smaller. */}
      <section className="mb-8">
        <div className="grid md:grid-cols-2 gap-4">
          <Surface variant="raised" className="p-8 flex flex-col justify-between min-h-[180px]">
            <MoneyStat
              label="Money moved"
              paise={moneyMoved.capturedPaise}
              size="primary"
            />
            <div className="text-sm text-on-ink-dim mt-4">
              {moneyMoved.capturedCount} captured payment{moneyMoved.capturedCount === 1 ? "" : "s"}
            </div>
          </Surface>
          <Surface variant="raised" className="p-8 flex flex-col justify-between min-h-[180px]">
            <MoneyStat
              label="Money recovered"
              paise={recoveryStats.recoveredPaise}
              tone="allow"
              size="primary"
            />
            <div className="text-sm text-on-ink-dim mt-4">
              {recoveryStats.recoveredCount} of {recoveryStats.failureCount} failed payment{recoveryStats.failureCount === 1 ? "" : "s"} brought back
            </div>
          </Surface>
        </div>
      </section>

      {/* Asymmetric on purpose: the composition bar needs real width to be
          readable, the two counts do not. Size follows content, not decoration. */}
      <section className="grid lg:grid-cols-[1fr_1fr_1.7fr] gap-4 mb-14">
        <Surface variant="flush" className="p-5">
          <Stat
            label="Refusals"
            value={decisionStats.totalRefusals}
            tone="deny"
            caption="Evidence the bound is real, not a gap"
          />
        </Surface>
        <Surface variant="flush" className="p-5">
          <Stat
            label="Deterministic vs. model"
            value={
              <span>
                {decisionStats.deterministicCount}
                <span className="text-on-ink-faint text-[0.55em] mx-1.5">/</span>
                {decisionStats.modelInfluencedCount}
              </span>
            }
            caption="Arithmetic-only vs. a model's judgment"
          />
        </Surface>
        <Surface variant="flush" className="p-5 flex flex-col">
          <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">
            Every logged decision
          </div>
          <div className="mt-auto pt-4">
            {decisionCounts.allow + decisionCounts.deny + decisionCounts.escalate === 0 ? (
              <p className="text-sm text-on-ink-dim">Nothing decided yet.</p>
            ) : (
              <DecisionComposition allow={decisionCounts.allow} deny={decisionCounts.deny} escalate={decisionCounts.escalate} />
            )}
          </div>
        </Surface>
      </section>

      <AuditTrail initialEntries={auditTrail} />
    </div>
  );
}

function StepMark({ done }: { done: boolean }) {
  return (
    <span
      className={`flex items-center justify-center h-4 w-4 rounded-full shrink-0 ${
        done ? "bg-allow-wash" : "border border-ink-line"
      }`}
      aria-hidden="true"
    >
      {done && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5.2 4 7.7 8.5 2.5" stroke="var(--allow-bright)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}
