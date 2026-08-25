import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRewardSettingsForDashboard, getRewardLedgerStats } from "@/lib/dashboard";
import { setRewardSettings } from "./actions";

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;

  const [settings, stats] = await Promise.all([getRewardSettingsForDashboard(merchant.id), getRewardLedgerStats(merchant.id)]);

  return (
    <main className="max-w-2xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Reward coins</h1>
        <p className="text-sm text-gray-500">
          Buyers earn coins on a captured purchase and can redeem them against a future one — both directions are real money actions, gated and bounded exactly like any other purchase.
        </p>
      </header>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Ledger</h2>
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Issued" value={stats.totalIssuedCoins} />
          <Stat label="Redeemed" value={stats.totalRedeemedCoins} />
          <Stat label="Outstanding" value={stats.netOutstandingCoins} />
        </div>
        <p className="text-xs text-gray-500 mt-3">{stats.ledgerEntryCount} ledger entries total. Every entry ties back to a real, gated money action.</p>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-1">{settings ? "Program settings" : "Rewards are not enabled"}</h2>
        <p className="text-sm text-gray-500 mb-3">
          {settings
            ? "Coins are only redeemable against purchases with this merchant — not for external credit of any kind."
            : "No settings saved yet. Set a coin value and rate below to turn rewards on."}
        </p>
        <form action={setRewardSettings} className="space-y-4 text-sm">
          <label className="flex flex-col gap-1">
            Value per coin (rupees)
            <input name="paisePerCoinRupees" type="number" step="0.01" min="0.01" required defaultValue={settings ? (settings.paisePerCoin / 100).toFixed(2) : ""} className="border rounded px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1">
            Issue rate (% of a captured purchase&apos;s value, in coins)
            <input
              name="issueRatePermille"
              type="number"
              step="1"
              min="0"
              max="1000"
              required
              defaultValue={settings ? settings.issueRatePermille : ""}
              className="border rounded px-3 py-2"
            />
            <span className="text-xs text-gray-500">Entered as per-mille (out of 1000) so the arithmetic stays integer — e.g. 50 means 5%.</span>
          </label>
          <label className="flex flex-col gap-1">
            Max redemption per purchase (%)
            <input
              name="maxRedemptionPercent"
              type="number"
              step="1"
              min="0"
              max="100"
              required
              defaultValue={settings ? settings.maxRedemptionPercent : ""}
              className="border rounded px-3 py-2"
            />
          </label>
          <button type="submit" className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
            {settings ? "Save" : "Enable rewards"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border px-2 py-3 bg-gray-50">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
