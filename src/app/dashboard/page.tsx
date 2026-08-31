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
  getCapturedMoneyRows,
  getDecisionRows,
  getRecoveredMoneyRows,
  getRewardLedgerStats,
} from "@/lib/dashboard";
import { toCumulativeMoneySeries, toDecisionSeries, toCapUtilisation } from "@/lib/chart-series";
import { getRecoveryStats } from "@/lib/recovery/attribution";
import { getDecisionStats } from "@/lib/explainability";
import { getSessionMerchant } from "@/lib/auth";
import { approveEscalation, rejectEscalation } from "./actions";
import { AuditTrail } from "./audit-trail";
import { formatPaise as rupees } from "@/lib/money";
import { PageHeader, Surface, MoneyStat, Stat, Button, DecisionComposition, MoneyFlowChart, DecisionActivityChart, CapUtilisationChart } from "@/components/ui";
import { MoneyAtRisk } from "./money-at-risk";

/** The window every chart on this page shares, so they read against one another. */
const CHART_WINDOW_DAYS = 30;

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function DashboardPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [auditTrail, escalations, razorpayStatus, agents, moneyMoved, decisionCounts, recoveryStats, decisionStats, moneyAtRisk, capturedRows, decisionRows, recoveredRows, rewardStats] =
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
      getCapturedMoneyRows(merchant.id, CHART_WINDOW_DAYS),
      getDecisionRows(merchant.id, CHART_WINDOW_DAYS),
      getRecoveredMoneyRows(merchant.id, CHART_WINDOW_DAYS),
      getRewardLedgerStats(merchant.id),
    ]);

  // Shaped on the server so the client bundle never sees the raw rows,
  // and so the honesty gate is decided from real data before render.
  const movedSeries = toCumulativeMoneySeries(capturedRows, CHART_WINDOW_DAYS);
  const recoveredSeries = toCumulativeMoneySeries(recoveredRows, CHART_WINDOW_DAYS);
  const decisionSeries = toDecisionSeries(decisionRows, CHART_WINDOW_DAYS);
  const capRows = toCapUtilisation(agents);

  const hasAgentWithCap = agents.some((a) => a.cap !== null);
  const isFirstRun = !razorpayStatus.connected || agents.length === 0 || !hasAgentWithCap;

  return (
    <div>
      <PageHeader
        title="Overview"
      />

      {isFirstRun && (
        <Surface variant="glass" className="relative overflow-hidden p-8 mb-12 flex flex-col gap-1">
          <span aria-hidden="true" className="absolute left-0 inset-y-0 w-1 bg-accent/80 shadow-[0_0_10px_rgba(13,148,251,0.5)]" />
          <h2 className="text-xl font-medium tracking-tight text-white flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Get set up
          </h2>
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
        <section className="mb-14">
          <div className="flex items-center gap-3 mb-5">
            <h2 className="text-xl font-medium text-white tracking-tight">
              Tasks
            </h2>
            <span className="text-xs font-semibold text-escalate-bright px-2.5 py-1 bg-escalate-wash border border-escalate/20 rounded-full shadow-[0_0_8px_rgba(232,161,61,0.15)]">
              {escalations.length} to review
            </span>
          </div>
          <Surface variant="glass" className="divide-y divide-white/10 overflow-hidden">
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
      <section className="mb-10">
        <div className="grid md:grid-cols-2 gap-6">
          <Surface variant="glass" className="p-8 flex flex-col justify-between min-h-[190px] relative group overflow-hidden">
            {/* Subtle glow behind the metric */}
            <div className="absolute top-0 right-0 w-64 h-64 bg-accent-wash rounded-full blur-[80px] -mr-16 -mt-16 opacity-30 group-hover:opacity-50 transition-opacity duration-700 pointer-events-none" />
            <div className="relative z-10">
            <MoneyStat
              label="Money moved"
              paise={moneyMoved.capturedPaise}
              size="primary"
            />
            <div className="text-sm text-on-ink-dim mt-4">
              {moneyMoved.capturedCount} captured payment{moneyMoved.capturedCount === 1 ? "" : "s"}
            </div>
            </div>
          </Surface>
          <Surface variant="glass" className="p-8 flex flex-col justify-between min-h-[190px] relative group overflow-hidden">
            {/* Subtle glow behind the metric */}
            <div className="absolute top-0 right-0 w-64 h-64 bg-allow-wash rounded-full blur-[80px] -mr-16 -mt-16 opacity-20 group-hover:opacity-40 transition-opacity duration-700 pointer-events-none" />
            <div className="relative z-10">
            <MoneyStat
              label="Money recovered"
              paise={recoveryStats.recoveredPaise}
              tone="allow"
              size="primary"
            />
            <div className="text-sm text-on-ink-dim mt-4">
              {recoveryStats.recoveredCount} of {recoveryStats.failureCount} failed payment{recoveryStats.failureCount === 1 ? "" : "s"} brought back
            </div>
            </div>
          </Surface>
        </div>
      </section>

      {/* Asymmetric on purpose: the composition bar needs real width to be
          readable, the two counts do not. Size follows content, not decoration. */}
      <section className="grid lg:grid-cols-[1fr_1fr_1.7fr] gap-6 mb-16">
        <Surface variant="glass" className="p-6 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-deny-wash rounded-full blur-[50px] -mr-8 -mt-8 opacity-20 group-hover:opacity-40 transition-opacity duration-700 pointer-events-none" />
          <div className="relative z-10">
          <Stat
            label="Refusals"
            value={decisionStats.totalRefusals}
            tone="deny"
            caption="Evidence the bound is real, not a gap"
          />
          </div>
        </Surface>
        <Surface variant="glass" className="p-6 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-[50px] -mr-8 -mt-8 opacity-30 group-hover:opacity-50 transition-opacity duration-700 pointer-events-none" />
          <div className="relative z-10">
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
          </div>
        </Surface>
        <Surface variant="glass" className="p-6 flex flex-col relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-full h-32 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
          <div className="relative z-10 flex flex-col h-full">
            <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-white/40 font-semibold">
              Every logged decision
            </div>
            <div className="mt-auto pt-4">
            {decisionCounts.allow + decisionCounts.deny + decisionCounts.escalate === 0 ? (
              <p className="text-sm text-on-ink-dim">Nothing decided yet.</p>
            ) : (
              <DecisionComposition allow={decisionCounts.allow} deny={decisionCounts.deny} escalate={decisionCounts.escalate} />
            )}
            </div>
          </div>
        </Surface>
      </section>

      {/* Charts sit between the headline numbers and the raw stream: they
          are the same facts at a different resolution. Each one renders a
          curve only when chart-series.ts's gate says there is genuinely
          enough activity to draw one honestly. */}
      <section className="grid gap-6 mb-16">
        <Surface variant="glass" className="p-6">
          <MoneyFlowChart
            moved={movedSeries}
            recovered={recoveredSeries}
            windowDays={CHART_WINDOW_DAYS}
            transactionCount={capturedRows.length + recoveredRows.length}
          />
        </Surface>

        <div className="grid lg:grid-cols-2 gap-6">
          <Surface variant="glass" className="p-6">
            <DecisionActivityChart points={decisionSeries} windowDays={CHART_WINDOW_DAYS} />
          </Surface>
          <Surface variant="glass" className="p-6">
            <CapUtilisationChart rows={capRows} />
          </Surface>
        </div>
      </section>

      {/* The reward loop, surfaced here rather than only inside its own
          section: a buyer earning coins on a capture and spending them
          again is a money action like any other, and belongs on the page
          that shows money moving. */}
      {rewardStats.ledgerEntryCount > 0 && (
        <Surface variant="glass" className="p-6 mb-16">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <h3 className="text-[var(--t-h4)] font-medium tracking-tight text-on-ink">Reward coins</h3>
              <p className="text-sm text-on-ink-dim mt-1 max-w-[52ch]">
                Buyers earn coins on a captured purchase and redeem them against a future one, or against AI credits.
              </p>
            </div>
            <Link
              href="/dashboard/rewards"
              className="text-sm text-accent hover:text-accent-bright underline underline-offset-2 shrink-0"
            >
              Open the coin program
            </Link>
          </div>
          <div className="grid grid-cols-3 gap-6">
            <Stat label="Issued" value={rewardStats.totalIssuedCoins} tone="allow" />
            <Stat label="Redeemed" value={rewardStats.totalRedeemedCoins} tone="accent" />
            <Stat label="Outstanding" value={rewardStats.netOutstandingCoins} />
          </div>
        </Surface>
      )}

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
