import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getAuditTrail,
  getPendingEscalations,
  getRazorpayConnectionStatus,
  getAgentsWithCaps,
  getMoneyMovedStats,
  getDecisionCounts,
} from "@/lib/dashboard";
import { getRecoveryStats } from "@/lib/recovery/attribution";
import { getDecisionStats } from "@/lib/explainability";
import { getSessionMerchant } from "@/lib/auth";
import { approveEscalation, rejectEscalation } from "./actions";
import { AuditTrail } from "./audit-trail";
import { formatPaise as rupees } from "@/lib/money";
import { PageHeader, Surface, MoneyStat, Stat, Button, DecisionComposition } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function DashboardPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [auditTrail, escalations, razorpayStatus, agents, moneyMoved, decisionCounts, recoveryStats, decisionStats] =
    await Promise.all([
      getAuditTrail(merchant.id, 100),
      getPendingEscalations(merchant.id),
      getRazorpayConnectionStatus(merchant.id),
      getAgentsWithCaps(merchant.id),
      getMoneyMovedStats(merchant.id),
      getDecisionCounts(merchant.id),
      getRecoveryStats(merchant.id),
      getDecisionStats(merchant.id),
    ]);

  const hasAgentWithCap = agents.some((a) => a.cap !== null);
  const isFirstRun = !razorpayStatus.connected || agents.length === 0 || !hasAgentWithCap;

  return (
    <div>
      <PageHeader
        title="Overview"
        description="What happened with your money, and what the system refused to do about it."
      />

      {isFirstRun && (
        <Surface variant="raised" className="p-5 mb-8 border-accent-wash">
          <h2 className="font-medium text-on-ink mb-3 text-sm">Get set up</h2>
          <ol className="space-y-2 text-sm">
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
        <section className="mb-8">
          <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">
            Waiting on you
          </h2>
          <div className="space-y-3">
            {escalations.map((esc) => (
              <Surface key={esc.id} variant="raised" className="p-4 border-escalate-line">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span className="font-medium text-on-ink">
                      {esc.agent?.name ?? "Unknown agent"} —{" "}
                      <span className="font-mono">{rupees(esc.moneyAction.amountPaise)}</span>
                    </span>
                    <span className="text-xs text-on-ink-faint ml-2 font-mono">{formatDate(esc.createdAt)}</span>
                  </div>
                  <div className="flex gap-2">
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
                <p className="text-sm text-on-ink-dim mt-1.5">{esc.riskReason}</p>
              </Surface>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <Surface variant="raised" className="p-5">
          <MoneyStat label="Money moved" paise={moneyMoved.capturedPaise} caption={`${moneyMoved.capturedCount} captured payments`} />
        </Surface>
        <Surface variant="raised" className="p-5">
          <MoneyStat label="Money recovered" paise={recoveryStats.recoveredPaise} tone="allow" caption={`${recoveryStats.recoveredCount} of ${recoveryStats.failureCount} failures`} />
        </Surface>
        <Surface variant="raised" className="p-5">
          <Stat
            label="Refusals"
            value={decisionStats.totalRefusals}
            tone="deny"
            caption="Evidence the bound is real, not a gap"
          />
        </Surface>
        <Surface variant="raised" className="p-5">
          <Stat
            label="Deterministic vs. model"
            value={
              <span>
                {decisionStats.deterministicCount}
                <span className="text-on-ink-faint text-[0.5em] mx-1">/</span>
                {decisionStats.modelInfluencedCount}
              </span>
            }
            caption="Arithmetic-only vs. a model's judgment"
          />
        </Surface>
      </section>

      <section className="mb-8">
        <Surface variant="raised" className="p-5">
          <h2 className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium mb-3">
            Every logged decision
          </h2>
          <DecisionComposition allow={decisionCounts.allow} deny={decisionCounts.deny} escalate={decisionCounts.escalate} />
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
