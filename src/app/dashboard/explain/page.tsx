import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getUnifiedDecisions, getDecisionStats, type DecisionSource, type DecisionKind } from "@/lib/explainability";
import { DecisionList } from "./decision-list";
import { PageHeader, Surface, Stat, EmptyState, Select } from "@/components/ui";

const SOURCE_FILTERS: { value: DecisionSource | "all"; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "gate", label: "Gate" },
  { value: "offer_engine", label: "Offer engine" },
  { value: "recovery", label: "Recovery" },
  { value: "risk_escalation", label: "Risk escalation" },
  { value: "negotiation", label: "Negotiation" },
];

const KIND_FILTERS: { value: DecisionKind | "all"; label: string }[] = [
  { value: "all", label: "Refusals & deferrals" },
  { value: "refusal", label: "Refusals only" },
  { value: "deferral", label: "Deferrals only" },
];

export default async function ExplainPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; kind?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { source, kind } = await searchParams;
  const sourceFilter = source && source !== "all" ? (source as DecisionSource) : undefined;
  const kindFilter = kind && kind !== "all" ? (kind as DecisionKind) : undefined;

  const [stats, decisions] = await Promise.all([
    getDecisionStats(merchant.id),
    getUnifiedDecisions(merchant.id, { limit: 50, source: sourceFilter, kind: kindFilter }),
  ]);

  const totalDecided = stats.deterministicCount + stats.modelInfluencedCount;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Why the system said no"
        description="Every time an agent, a checkout, or the recovery pipeline was refused, or deferred to you for a decision — across the gate, the upsell engine, and revenue recovery, all in one place. A refusal here is evidence a bound is real, not a gap to close."
      />

      <Surface variant="raised" className="p-6">
        <div className="grid grid-cols-2 sm:grid-cols-[1.4fr_1fr_1fr_1fr] gap-6 items-end">
          <Stat label="Refusals" value={stats.totalRefusals} tone="deny" size="primary" />
          <Stat label="Deferrals to you" value={stats.totalDeferrals} tone="escalate" />
          <Stat label="Arithmetic, no model" value={stats.deterministicCount} tone="allow" />
          <Stat label="A model's judgment" value={stats.modelInfluencedCount} tone="accent" />
        </div>

        {totalDecided > 0 && (
          <div className="mt-5">
            <div className="w-full h-2 rounded-full bg-ink-overlay overflow-hidden flex">
              <div
                className="h-full bg-allow"
                style={{ width: `${(stats.deterministicCount / totalDecided) * 100}%` }}
              />
              <div
                className="h-full bg-accent"
                style={{ width: `${(stats.modelInfluencedCount / totalDecided) * 100}%` }}
              />
            </div>
            <p className="text-xs text-on-ink-faint mt-2">
              {stats.deterministicCount} of {totalDecided} decisions were pure arithmetic in code — only{" "}
              {stats.modelInfluencedCount} involved a model&apos;s judgment at all.
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-5 pt-4 border-t border-ink-line-soft text-xs">
          {Object.entries(stats.bySource).map(([src, count]) => (
            <div key={src} className="flex justify-between">
              <dt className="text-on-ink-faint capitalize">{src.replace("_", " ")}</dt>
              <dd className="font-mono text-on-ink">{count}</dd>
            </div>
          ))}
        </dl>
      </Surface>

      <section>
        <form className="flex flex-wrap gap-3 mb-4" method="get">
          <Select name="source" defaultValue={source ?? "all"} className="w-auto">
            {SOURCE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          <Select name="kind" defaultValue={kind ?? "all"} className="w-auto">
            {KIND_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          <button
            type="submit"
            className="text-sm px-3 py-2 rounded-[var(--radius)] bg-ink-overlay border border-ink-line text-on-ink hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)]"
          >
            Filter
          </button>
        </form>

        {decisions.length === 0 ? (
          <EmptyState title="No decisions match this filter" description="Try a different source or kind." />
        ) : (
          <DecisionList decisions={decisions} />
        )}
      </section>
    </div>
  );
}
