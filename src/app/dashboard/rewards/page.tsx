import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRewardSettingsForDashboard, getRewardLedgerStats, getAiCreditTiersForDashboard } from "@/lib/dashboard";
import { setRewardSettings, createAiCreditTier, toggleAiCreditTier } from "./actions";
import { TIER_PRESETS } from "./tier-presets";
import { PageHeader, Surface, Stat, Field, Input, Select, Button, EmptyState } from "@/components/ui";

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;

  const [settings, stats, tiers] = await Promise.all([
    getRewardSettingsForDashboard(merchant.id),
    getRewardLedgerStats(merchant.id),
    getAiCreditTiersForDashboard(merchant.id),
  ]);
  const availablePresets = TIER_PRESETS.filter((p) => !tiers.some((t) => t.modelId === p.modelId));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reward coins"
        description="Buyers earn coins on a captured purchase and can redeem them against a future one — both directions are real money actions, gated and bounded exactly like any other purchase."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      <Surface variant="raised" className="p-6">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-4">Ledger</h2>
        <div className="grid grid-cols-3 gap-6">
          <Stat label="Issued" value={stats.totalIssuedCoins} />
          <Stat label="Redeemed" value={stats.totalRedeemedCoins} />
          <Stat label="Outstanding" value={stats.netOutstandingCoins} tone="accent" />
        </div>
        <p className="text-xs text-on-ink-faint mt-4">
          {stats.ledgerEntryCount} ledger entries total. Every entry ties back to a real, gated money action.
        </p>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">
          {settings ? "Program settings" : "Rewards are not enabled"}
        </h2>
        <p className="text-sm text-on-ink-dim mb-4 max-w-[var(--measure)]">
          {settings
            ? "Coins are only redeemable against purchases with this merchant — not for external credit of any kind."
            : "No settings saved yet. Set a coin value and rate below to turn rewards on."}
        </p>
        <form action={setRewardSettings} className="space-y-4 max-w-sm">
          <Field label="Value per coin (rupees)">
            <Input
              name="paisePerCoinRupees"
              type="number"
              step="0.01"
              min="0.01"
              required
              defaultValue={settings ? (settings.paisePerCoin / 100).toFixed(2) : ""}
            />
          </Field>
          <Field
            label="Issue rate (% of a captured purchase's value, in coins)"
            help="Entered as per-mille (out of 1000) so the arithmetic stays integer — e.g. 50 means 5%."
          >
            <Input
              name="issueRatePermille"
              type="number"
              step="1"
              min="0"
              max="1000"
              required
              defaultValue={settings ? settings.issueRatePermille : ""}
            />
          </Field>
          <Field label="Max redemption per purchase (%)">
            <Input
              name="maxRedemptionPercent"
              type="number"
              step="1"
              min="0"
              max="100"
              required
              defaultValue={settings ? settings.maxRedemptionPercent : ""}
            />
          </Field>
          <Button type="submit" variant="primary" pendingLabel="Saving…">
            {settings ? "Save" : "Enable rewards"}
          </Button>
        </form>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">AI credit tiers</h2>
        <p className="text-sm text-on-ink-dim mb-4 max-w-[var(--measure)]">
          Buyers can spend coins on a real AI response from one of these models — each one genuinely served by Groq, under its real name, at whatever price you set. No model ever decides its own price; that&apos;s always this fixed integer.
        </p>

        {tiers.length === 0 ? (
          <EmptyState title="No tiers yet" description="Add one below to let buyers redeem coins for a real AI response." />
        ) : (
          <div className="space-y-2 mb-5">
            {tiers.map((tier) => (
              <div key={tier.id} className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-ink-line px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-on-ink">{tier.displayName}</p>
                  <p className="text-xs text-on-ink-faint font-mono">{tier.modelId}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-mono text-on-ink-dim">{tier.coinsPerRequest} coins/response</span>
                  <form action={toggleAiCreditTier}>
                    <input type="hidden" name="tierId" value={tier.id} />
                    <input type="hidden" name="enabled" value={tier.enabled ? "false" : "true"} />
                    <Button type="submit" variant={tier.enabled ? "secondary" : "primary"} size="sm" pendingLabel="Saving…">
                      {tier.enabled ? "Disable" : "Enable"}
                    </Button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}

        {availablePresets.length > 0 ? (
          <form action={createAiCreditTier} className="space-y-3 max-w-sm">
            <Field label="Model">
              <Select name="modelId" required>
                {availablePresets.map((p) => (
                  <option key={p.modelId} value={p.modelId}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Coins per response">
              <Input name="coinsPerRequest" type="number" step="1" min="1" required defaultValue="10" />
            </Field>
            <Button type="submit" variant="secondary" pendingLabel="Adding…">
              Add tier
            </Button>
          </form>
        ) : (
          <p className="text-xs text-on-ink-faint">Every available model already has a tier.</p>
        )}
      </Surface>
    </div>
  );
}
