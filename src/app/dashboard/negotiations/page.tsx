import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRecentNegotiations, getNegotiableVariants } from "@/lib/dashboard";
import { formatPaise } from "@/lib/money";
import { setNegotiationFloor } from "./actions";
import { NegotiationList } from "./negotiation-list";

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  agreed: "Agreed",
  refused_turns_exhausted: "Refused — floor never reached",
  expired: "Expired",
  redeemed: "Redeemed",
};

export default async function NegotiationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;

  const [negotiations, variants] = await Promise.all([
    getRecentNegotiations(merchant.id, 50),
    getNegotiableVariants(merchant.id),
  ]);

  const refusedCount = negotiations.filter((n) => n.status === "refused_turns_exhausted").length;
  const agreedCount = negotiations.filter((n) => n.status === "agreed" || n.status === "redeemed").length;

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Negotiation</h1>
        <p className="text-sm text-gray-500">
          A buyer — an AI agent or a person in chat — can ask for a better price on any variant you&apos;ve set a floor for. Your agent will counter, but never below the floor you set here. A refusal below is evidence the floor held, not a gap.
        </p>
      </header>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}

      <section className="border rounded-lg p-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Total negotiations" value={negotiations.length} />
          <Stat label="Agreed" value={agreedCount} />
          <Stat label="Refused — floor held" value={refusedCount} emphasize />
        </div>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Negotiation floors</h2>
        <p className="text-xs text-gray-500 mb-3">
          A variant with no floor set is not negotiable at all — that&apos;s the default, never a permissive one. Set a floor to allow negotiation on it.
        </p>
        <ul className="space-y-2">
          {variants.map((v) => (
            <li key={v.variantId} className="border rounded px-3 py-2 text-sm flex items-center justify-between gap-3">
              <div>
                <span className="font-medium">{v.productName}</span>
                <span className="text-gray-500 ml-2">
                  {v.sku} — catalogue {formatPaise(v.pricePaise)}
                  {v.floorPricePaise !== null && <> — floor {formatPaise(v.floorPricePaise)}</>}
                  {v.belowCostFloorAcknowledged && <span className="ml-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">below cost, acknowledged</span>}
                </span>
              </div>
              <details>
                <summary className="text-xs text-blue-600 hover:underline cursor-pointer">
                  {v.floorPricePaise === null ? "Set floor" : "Edit floor"}
                </summary>
                <form action={setNegotiationFloor} className="flex items-center gap-2 mt-2">
                  <input type="hidden" name="variantId" value={v.variantId} />
                  <input
                    name="floorPriceRupees"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Leave blank to clear"
                    defaultValue={v.floorPricePaise !== null ? (v.floorPricePaise / 100).toFixed(2) : ""}
                    className="border rounded px-2 py-1 w-32"
                  />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" name="belowCostAcknowledged" defaultChecked={v.belowCostFloorAcknowledged} />
                    Below cost, OK
                  </label>
                  <button type="submit" className="text-xs px-2 py-1 rounded border hover:bg-gray-50">
                    Save
                  </button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Recent negotiations</h2>
        {negotiations.length === 0 ? (
          <p className="text-sm text-gray-500">No negotiations yet.</p>
        ) : (
          <NegotiationList negotiations={negotiations} statusLabels={STATUS_LABELS} />
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className={`rounded border px-2 py-3 text-center ${emphasize ? "bg-amber-50 border-amber-200" : "bg-gray-50"}`}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
