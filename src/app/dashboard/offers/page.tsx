import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getOfferDecisionStats, getRecentOfferDecisions } from "@/lib/dashboard";
import { getMerchantBundles, getMerchantVariantsForBundling } from "@/lib/bundles";
import { formatPaise } from "@/lib/money";
import { createBundle, archiveBundle } from "./actions";

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
    <main className="max-w-3xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Upsell offers</h1>
        <p className="text-sm text-gray-500">
          At checkout, an agent ranks a margin-filtered set of your bundles and offers at most one — or offers nothing when none of them clear your margin floor. Every run is recorded below, including the runs where it deliberately offered nothing.
        </p>
      </header>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">This week&apos;s decisions</h2>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 text-center">
          <Stat label="Runs" value={stats.totalRuns} />
          <Stat label="Offered" value={stats.offered} />
          <Stat label="Accepted" value={stats.accepted} />
          <Stat label="Declined" value={stats.declined} />
          <Stat label="No offer" value={stats.noOffer} emphasize />
        </div>
        <p className="text-xs text-gray-500 mt-3">
          &ldquo;No offer&rdquo; means the engine deliberately refused — nothing eligible, or nothing cleared the margin floor. That is a success, not a gap.
        </p>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Your bundles</h2>
        {bundleList.length === 0 && <p className="text-sm text-gray-500 mb-4">No bundles yet — create one below.</p>}
        <ul className="space-y-2 mb-4">
          {bundleList.map((b) => (
            <li key={b.id} className="border rounded px-3 py-2 flex items-center justify-between text-sm">
              <div>
                <span className={b.status === "archived" ? "text-gray-400 line-through" : "font-medium"}>{b.name}</span>
                <span className="text-gray-500 ml-2">
                  {formatPaise(b.bundlePricePaise)} — {b.items.map((i) => `${i.quantity}x ${i.sku}`).join(", ")}
                </span>
                {b.belowCostAcknowledged && <span className="ml-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">below cost, acknowledged</span>}
              </div>
              {b.status === "active" && (
                <form action={archiveBundle}>
                  <input type="hidden" name="bundleId" value={b.id} />
                  <button type="submit" className="text-xs text-red-600 hover:underline">
                    Archive
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>

        <details>
          <summary className="text-sm font-medium cursor-pointer">Create a bundle</summary>
          <form action={createBundle} className="space-y-3 text-sm mt-3">
            <label className="flex flex-col gap-1">
              Bundle name
              <input name="name" required className="border rounded px-3 py-2" />
            </label>

            <div>
              <p className="mb-1">Items</p>
              {variants.length === 0 && <p className="text-gray-500">No products yet — add some in Products first.</p>}
              <div className="space-y-1">
                {variants.map((v) => (
                  <label key={v.id} className="flex items-center gap-2">
                    <input type="checkbox" name={`item:${v.id}`} />
                    <span className="flex-1">
                      {v.productName} ({v.sku}) — {formatPaise(v.pricePaise)}
                    </span>
                    <input type="number" name={`qty:${v.id}`} defaultValue={1} min={1} className="w-16 border rounded px-2 py-1" />
                  </label>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1">
              Bundle price (rupees)
              <input name="bundlePriceRupees" type="number" step="0.01" min="0" required className="border rounded px-3 py-2" />
            </label>

            <label className="flex items-center gap-2">
              <input type="checkbox" name="belowCostAcknowledged" />
              I want this priced below the items&apos; total cost (deliberate loss-leader)
            </label>

            <button type="submit" className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
              Create bundle
            </button>
          </form>
        </details>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Recent decisions</h2>
        {decisions.length === 0 && <p className="text-sm text-gray-500">No offer engine runs yet — one runs automatically whenever a buyer has an item in their cart.</p>}
        <ul className="space-y-2">
          {decisions.map((d) => (
            <li key={d.id} className="border rounded px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-500">{new Date(d.createdAt).toLocaleString()}</span>
                <span className="text-xs text-gray-400">
                  {d.eligibleCandidateCount} eligible, {d.belowMarginFloorCount} below margin floor
                </span>
              </div>
              {d.offer ? (
                <p className="mt-1">
                  Offered <span className="font-medium">{d.offer.bundleName}</span> at {formatPaise(d.offer.amountPaise)} —{" "}
                  <span className="text-gray-600">{d.offer.status}</span>. &ldquo;{d.offer.reasonText}&rdquo;
                </p>
              ) : (
                <p className="mt-1 text-gray-700">No offer — {d.noOfferReason}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className={`rounded border px-2 py-3 ${emphasize ? "bg-amber-50 border-amber-200" : "bg-gray-50"}`}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
