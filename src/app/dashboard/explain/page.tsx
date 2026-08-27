import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getUnifiedDecisions, getDecisionStats, type DecisionSource, type DecisionKind } from "@/lib/explainability";
import { DecisionList } from "./decision-list";

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

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Why the system said no</h1>
        <p className="text-sm text-gray-500">
          Every time an agent, a checkout, or the recovery pipeline was refused, or deferred to you for a decision — across the gate, the upsell engine, and revenue recovery, all in one place. A refusal here is evidence a bound is real, not a gap to close.
        </p>
      </header>

      <section className="border rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <Stat label="Refusals" value={stats.totalRefusals} emphasize />
          <Stat label="Deferrals to you" value={stats.totalDeferrals} />
          <Stat label="Arithmetic, no model" value={stats.deterministicCount} />
          <Stat label="A model's judgment" value={stats.modelInfluencedCount} />
        </div>
        <p className="text-xs text-gray-500 mt-3">
          A refusal means the system declined on its own. A deferral means it asked you instead — that&apos;s not a refusal, it&apos;s a request for your judgment. {stats.deterministicCount} of the {stats.deterministicCount + stats.modelInfluencedCount} decisions above were pure arithmetic in code; only {stats.modelInfluencedCount} involved a model&apos;s judgment at all.
        </p>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-xs text-gray-500">
          {Object.entries(stats.bySource).map(([src, count]) => (
            <div key={src} className="flex justify-between border-t pt-1">
              <dt className="capitalize">{src.replace("_", " ")}</dt>
              <dd className="font-medium text-gray-700">{count}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <form className="flex flex-wrap gap-3 mb-4 text-sm" method="get">
          <select name="source" defaultValue={source ?? "all"} className="border rounded px-2 py-1">
            {SOURCE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <select name="kind" defaultValue={kind ?? "all"} className="border rounded px-2 py-1">
            {KIND_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <button type="submit" className="text-sm px-3 py-1 rounded border hover:bg-gray-50">Filter</button>
        </form>

        {decisions.length === 0 ? (
          <p className="text-sm text-gray-500">No decisions match this filter yet.</p>
        ) : (
          <DecisionList decisions={decisions} />
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div>
      <div className={emphasize ? "text-2xl font-semibold text-amber-700" : "text-2xl font-semibold"}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
