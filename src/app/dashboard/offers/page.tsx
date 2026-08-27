import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getOfferDecisionStats, getRecentOfferDecisions } from "@/lib/dashboard";
import { getMerchantBundles, getMerchantVariantsForBundling } from "@/lib/bundles";
import { formatPaise } from "@/lib/money";
import { createBundle, archiveBundle } from "./actions";
import { PageHeader, Surface, Stat, DetailsToggle, Input, Button, EmptyState } from "@/components/ui";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;

  const [stats, bundleList, variants, decisions] = await Promise.all([
    getOfferDecisionStats(merchant.id),
    getMerchantBundles(merchant.id),
    getMerchantVariantsForBundling(merchant.id),
    getRecentOfferDecisions(merchant.id, 30),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Upsell offers"
        description="At checkout, an agent ranks a margin-filtered set of your bundles and offers at most one — or offers nothing when none of them clear your margin floor. Every run is recorded below, including the runs where it deliberately offered nothing."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      <Surface variant="raised" className="p-6">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-4">This week&apos;s decisions</h2>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
          <Stat label="Runs" value={stats.totalRuns} />
          <Stat label="Offered" value={stats.offered} />
          <Stat label="Accepted" value={stats.accepted} tone="allow" />
          <Stat label="Declined" value={stats.declined} />
          <Stat label="No offer" value={stats.noOffer} tone="deny" />
        </div>
        <p className="text-xs text-on-ink-faint mt-4 max-w-[var(--measure)]">
          &ldquo;No offer&rdquo; means the engine deliberately refused — nothing eligible, or nothing cleared the margin floor. That is a success, not a gap.
        </p>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-3">Your bundles</h2>
        {bundleList.length === 0 && (
          <p className="text-sm text-on-ink-dim mb-4">No bundles yet — create one below.</p>
        )}
        <ul className="space-y-2 mb-4">
          {bundleList.map((b) => (
            <li
              key={b.id}
              className="rounded-[var(--radius)] border border-ink-line bg-ink-overlay px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap text-sm"
            >
              <div>
                <span className={b.status === "archived" ? "text-on-ink-faint line-through" : "font-medium text-on-ink"}>
                  {b.name}
                </span>
                <span className="text-on-ink-dim ml-2 font-mono">
                  {formatPaise(b.bundlePricePaise)} — {b.items.map((i) => `${i.quantity}x ${i.sku}`).join(", ")}
                </span>
                {b.belowCostAcknowledged && (
                  <span className="ml-2 text-xs text-escalate-bright bg-escalate-wash border border-escalate-line rounded-full px-1.5 py-0.5">
                    below cost, acknowledged
                  </span>
                )}
              </div>
              {b.status === "active" && (
                <form action={archiveBundle}>
                  <input type="hidden" name="bundleId" value={b.id} />
                  <button type="submit" className="text-xs text-deny-bright hover:text-deny-line transition-colors">
                    Archive
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>

        <DetailsToggle summary="Create a bundle">
          <form action={createBundle} className="space-y-3 mt-2 font-sans">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-on-ink-dim font-medium">Bundle name</span>
              <Input name="name" required />
            </label>

            <div>
              <p className="mb-1.5 text-sm text-on-ink-dim font-medium">Items</p>
              {variants.length === 0 && (
                <p className="text-sm text-on-ink-faint">No products yet — add some in Products first.</p>
              )}
              <div className="space-y-1.5">
                {variants.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-sm text-on-ink">
                    <input type="checkbox" name={`item:${v.id}`} />
                    <span className="flex-1 font-mono">
                      {v.productName} ({v.sku}) — {formatPaise(v.pricePaise)}
                    </span>
                    <Input type="number" name={`qty:${v.id}`} defaultValue={1} min={1} className="w-16" />
                  </label>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-on-ink-dim font-medium">Bundle price (rupees)</span>
              <Input name="bundlePriceRupees" type="number" step="0.01" min="0" required />
            </label>

            <label className="flex items-center gap-2 text-sm text-on-ink-dim">
              <input type="checkbox" name="belowCostAcknowledged" />
              I want this priced below the items&apos; total cost (deliberate loss-leader)
            </label>

            <Button type="submit" variant="primary" pendingLabel="Creating…">
              Create bundle
            </Button>
          </form>
        </DetailsToggle>
      </Surface>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">Recent decisions</h2>
        {decisions.length === 0 ? (
          <EmptyState title="No offer engine runs yet" description="One runs automatically whenever a buyer has an item in their cart." />
        ) : (
          <ul className="space-y-2">
            {decisions.map((d) => (
              <li key={d.id} className="rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised px-4 py-3 text-sm">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-on-ink-faint text-xs font-mono">{formatDate(d.createdAt)}</span>
                  <span className="text-xs text-on-ink-faint font-mono">
                    {d.eligibleCandidateCount} eligible, {d.belowMarginFloorCount} below margin floor
                  </span>
                </div>
                {d.offer ? (
                  <p className="mt-1.5 text-on-ink-dim">
                    Offered <span className="font-medium text-on-ink">{d.offer.bundleName}</span> at{" "}
                    <span className="font-mono">{formatPaise(d.offer.amountPaise)}</span> —{" "}
                    <span className="text-on-ink-faint">{d.offer.status}</span>. &ldquo;{d.offer.reasonText}&rdquo;
                  </p>
                ) : (
                  <p className="mt-1.5 text-on-ink">No offer — {d.noOfferReason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
