import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRazorpayConnectionStatus } from "@/lib/dashboard";
import { connectRazorpay, disconnectRazorpay } from "./actions";
import { PageHeader, Surface, Field, Input, Button } from "@/components/ui";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error, connected } = await searchParams;
  const status = await getRazorpayConnectionStatus(merchant.id);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Connect your own Razorpay test account. Every purchase your agents make settles into this account."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}
      {connected && (
        <p className="text-sm text-allow-bright bg-allow-wash border border-allow-line rounded-[var(--radius)] px-3 py-2">
          Razorpay account connected.
        </p>
      )}

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Razorpay account</h2>

        {status.connected ? (
          <div className="space-y-1.5">
            <p className="text-sm text-on-ink">
              Connected — <span className="font-mono text-on-ink-dim">{status.maskedKeyId}</span>
            </p>
            <p className="text-xs text-on-ink-faint">
              To use a different account, paste new credentials below — they replace the current ones after Razorpay confirms they work.
            </p>
          </div>
        ) : (
          <p className="text-sm text-on-ink-dim">Not connected. Agents cannot transact until you connect a Razorpay test account.</p>
        )}

        <form action={connectRazorpay} className="space-y-3 max-w-sm">
          <Field label="Key ID">
            <Input name="keyId" placeholder="rzp_test_..." required className="font-mono" />
          </Field>
          <Field label="Key Secret">
            <Input name="keySecret" type="password" required className="font-mono" />
          </Field>
          <p className="text-xs text-on-ink-faint">From your Razorpay dashboard → Settings → API Keys. Make sure Test Mode is on.</p>
          <Button type="submit" variant="primary" pendingLabel="Connecting…">
            {status.connected ? "Replace credentials" : "Connect"}
          </Button>
        </form>

        {status.connected && (
          <form action={disconnectRazorpay}>
            <Button type="submit" variant="destructive" size="sm" pendingLabel="Disconnecting…">
              Disconnect
            </Button>
          </form>
        )}
      </Surface>
    </div>
  );
}
