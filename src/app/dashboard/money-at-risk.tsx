import Link from "next/link";
import type { MoneyAtRiskSummary } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import { Surface, EmptyState } from "@/components/ui";

interface RiskRow {
  href: string;
  label: string;
  detail: string;
  show: boolean;
}

/**
 * Layer 15-4: the command view's leading section — "where am I losing
 * money right now" rather than "here are my agents." Every row here
 * reads from getMoneyAtRiskSummary, which is itself six real queries
 * over tables this app already owns (see dashboard.ts's docstring) —
 * nothing on this page is estimated or sampled. A category with
 * genuinely nothing to show is simply absent from the list, never a
 * zero rendered as if it were a meaningful finding.
 */
export function MoneyAtRisk({ summary }: { summary: MoneyAtRiskSummary }) {
  const rows: RiskRow[] = [
    {
      href: "/dashboard/recovery",
      label: "Failed payments awaiting recovery",
      detail: `${summary.failedPaymentsAwaitingRecovery.count} payment${summary.failedPaymentsAwaitingRecovery.count === 1 ? "" : "s"} · ${rupees(summary.failedPaymentsAwaitingRecovery.amountPaise)} not yet recovered`,
      show: summary.failedPaymentsAwaitingRecovery.count > 0,
    },
    {
      href: "/dashboard",
      label: "Abandoned carts",
      detail: `${summary.abandonedCarts.count} cart${summary.abandonedCarts.count === 1 ? "" : "s"} started, never checked out`,
      show: summary.abandonedCarts.count > 0,
    },
    {
      href: "/dashboard/products",
      label: "Out of stock with real demand",
      detail: `${summary.outOfStockWithDemand.count} variant${summary.outOfStockWithDemand.count === 1 ? "" : "s"} with a buyer waiting to be told when it's back`,
      show: summary.outOfStockWithDemand.count > 0,
    },
    {
      href: "/dashboard",
      label: "Pending escalations holding budget",
      detail: `${summary.pendingEscalations.count} decision${summary.pendingEscalations.count === 1 ? "" : "s"} · ${rupees(summary.pendingEscalations.amountPaise)} reserved, waiting on you`,
      show: summary.pendingEscalations.count > 0,
    },
    {
      href: "/dashboard/guardian",
      label: "Suspended agents blocking throughput",
      detail: `${summary.suspendedAgents.count} agent${summary.suspendedAgents.count === 1 ? "" : "s"} suspended by the Runtime Guardian`,
      show: summary.suspendedAgents.count > 0,
    },
    {
      href: "/dashboard/treasury",
      label: "AI spend against treasury budgets",
      detail: `${summary.aiSpendAgainstBudget.overBudgetUseCases} of ${summary.aiSpendAgainstBudget.configuredUseCases} configured use case${summary.aiSpendAgainstBudget.configuredUseCases === 1 ? "" : "s"} at or over budget`,
      show: summary.aiSpendAgainstBudget.overBudgetUseCases > 0,
    },
  ];

  const visible = rows.filter((r) => r.show);

  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-on-ink tracking-tight mb-4">
        Where money is at risk right now
      </h2>

      {visible.length === 0 ? (
        <EmptyState
          title="Nothing at risk right now"
          description="No unrecovered failed payments, abandoned carts, unmet restock demand, pending escalations, suspended agents, or AI use cases over budget."
        />
      ) : (
        <Surface variant="raised" className="divide-y divide-ink-line-soft">
          {visible.map((row) => (
            <Link
              key={row.label}
              href={row.href}
              className="group flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-ink-overlay transition-colors duration-[var(--dur-fast)]"
            >
              <span className="text-sm text-on-ink">{row.label}</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-mono text-on-ink-dim tabular-nums">{row.detail}</span>
                <span aria-hidden="true" className="text-on-ink-faint group-hover:text-accent transition-colors duration-[var(--dur-fast)]">
                  →
                </span>
              </span>
            </Link>
          ))}
        </Surface>
      )}
    </section>
  );
}
