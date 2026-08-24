import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRazorpayConnectionStatus } from "@/lib/dashboard";
import { connectRazorpay, disconnectRazorpay } from "./actions";

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
    <main className="max-w-2xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-gray-500">Connect your own Razorpay test account. Every purchase your agents make settles into this account.</p>
      </header>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>
      )}
      {connected && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">Razorpay account connected.</p>
      )}

      <section className="border rounded-lg p-4 space-y-4">
        <h2 className="text-lg font-semibold">Razorpay account</h2>

        {status.connected ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              Connected — <span className="font-mono">{status.maskedKeyId}</span>
            </p>
            <p className="text-xs text-gray-500">To use a different account, paste new credentials below — they replace the current ones after Razorpay confirms they work.</p>
          </div>
        ) : (
          <p className="text-sm text-gray-500">Not connected. Agents cannot transact until you connect a Razorpay test account.</p>
        )}

        <form action={connectRazorpay} className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            Key ID
            <input name="keyId" placeholder="rzp_test_..." required className="border rounded px-3 py-2 font-mono" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Key Secret
            <input name="keySecret" type="password" required className="border rounded px-3 py-2 font-mono" />
          </label>
          <p className="text-xs text-gray-500">From your Razorpay dashboard → Settings → API Keys. Make sure Test Mode is on.</p>
          <button type="submit" className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
            {status.connected ? "Replace credentials" : "Connect"}
          </button>
        </form>

        {status.connected && (
          <form action={disconnectRazorpay}>
            <button type="submit" className="text-sm px-3 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50">
              Disconnect
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
