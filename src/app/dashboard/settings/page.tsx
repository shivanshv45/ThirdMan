import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRazorpayConnectionStatus } from "@/lib/dashboard";
import { getAlertSettings } from "@/lib/notifications/merchant-alerts";
import { connectRazorpay, disconnectRazorpay, updateAlertSettings, changePassword } from "./actions";
import { PageHeader, Surface, Field, Input, Button } from "@/components/ui";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string; pwError?: string; pwChanged?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error, connected, pwError, pwChanged } = await searchParams;
  const status = await getRazorpayConnectionStatus(merchant.id);
  const alertSettings = await getAlertSettings(merchant.id);

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

      <Surface variant="raised" className="p-5 space-y-4">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Email alerts</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            A daily summary email, at most once a day, only when there&apos;s something waiting on you. Sent to <span className="font-mono text-on-ink">{merchant.email}</span>.
          </p>
        </div>

        <form action={updateAlertSettings} className="space-y-3">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-on-ink-dim">
              <input type="checkbox" name="escalationPendingEnabled" defaultChecked={alertSettings.escalationPendingEnabled} className="accent-accent" />
              Purchases waiting on your approval
            </label>
            <label className="flex items-center gap-2 text-sm text-on-ink-dim">
              <input type="checkbox" name="holdExpiringEnabled" defaultChecked={alertSettings.holdExpiringEnabled} className="accent-accent" />
              Escrow holds expiring soon
            </label>
            <label className="flex items-center gap-2 text-sm text-on-ink-dim">
              <input type="checkbox" name="notificationExhaustedEnabled" defaultChecked={alertSettings.notificationExhaustedEnabled} className="accent-accent" />
              Customer notifications that failed to deliver
            </label>
            <label className="flex items-center gap-2 text-sm text-on-ink-dim">
              <input type="checkbox" name="webhookExhaustedEnabled" defaultChecked={alertSettings.webhookExhaustedEnabled} className="accent-accent" />
              Webhook deliveries to your server that failed
            </label>
            <label className="flex items-center gap-2 text-sm text-on-ink-dim">
              <input type="checkbox" name="loginBurstEnabled" defaultChecked={alertSettings.loginBurstEnabled} className="accent-accent" />
              Bursts of failed login attempts on your account
            </label>
          </div>
          <Button type="submit" variant="secondary" size="sm" pendingLabel="Saving…">
            Save alert preferences
          </Button>
        </form>
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Password</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            Changing your password signs out every other session — only this one stays logged in.
          </p>
        </div>

        {pwError && (
          <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
            {pwError}
          </p>
        )}
        {pwChanged && (
          <p className="text-sm text-allow-bright bg-allow-wash border border-allow-line rounded-[var(--radius)] px-3 py-2">
            Password changed. Other sessions have been signed out.
          </p>
        )}

        <form action={changePassword} className="space-y-3 max-w-sm">
          {merchant.passwordHash && (
            <Field label="Current password">
              <Input name="currentPassword" type="password" required />
            </Field>
          )}
          <Field label="New password">
            <Input name="newPassword" type="password" required minLength={8} />
          </Field>
          <Field label="Confirm new password">
            <Input name="confirmPassword" type="password" required minLength={8} />
          </Field>
          <Button type="submit" variant="primary" pendingLabel="Changing…">
            {merchant.passwordHash ? "Change password" : "Set a password"}
          </Button>
        </form>
      </Surface>
    </div>
  );
}
