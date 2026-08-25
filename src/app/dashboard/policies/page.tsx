import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";
import { setMerchantPolicy } from "./actions";

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;
  const policy = await getMerchantPolicy(merchant.id);

  return (
    <main className="max-w-2xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Policies</h1>
        <p className="text-sm text-gray-500">
          Return, refund, and shipping terms — structured so an AI buyer can act on them, not just read them. A cautious agent that can&apos;t determine your return window may skip you.
        </p>
      </header>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-1">Current policy (as an agent would read it)</h2>
        <p className="text-sm text-gray-700 bg-gray-50 border rounded px-3 py-2">{describeMerchantPolicy(policy)}</p>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Edit</h2>
        <form action={setMerchantPolicy} className="space-y-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="returnsAccepted" defaultChecked={policy?.returnsAccepted ?? false} />
            Accept returns
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              Return window (days)
              <input name="returnWindowDays" type="number" min="0" step="1" defaultValue={policy?.returnWindowDays ?? ""} className="border rounded px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1">
              Refund method
              <select name="refundMethod" defaultValue={policy?.refundMethod ?? ""} className="border rounded px-3 py-2">
                <option value="">Not specified</option>
                <option value="original_payment_method">Original payment method</option>
                <option value="store_credit">Store credit</option>
                <option value="either">Either</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Restocking fee (%)
              <input name="restockingFeePercent" type="number" min="0" max="100" step="1" defaultValue={policy?.restockingFeePercent ?? ""} className="border rounded px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1">
              Handling time (days)
              <input name="handlingTimeDays" type="number" min="0" step="1" defaultValue={policy?.handlingTimeDays ?? ""} className="border rounded px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1">
              Warranty (months)
              <input name="warrantyMonths" type="number" min="0" step="1" defaultValue={policy?.warrantyMonths ?? ""} className="border rounded px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 col-span-2">
              Ships to (comma-separated region/country codes)
              <input name="shippingRegions" defaultValue={policy?.shippingRegions?.join(", ") ?? ""} placeholder="IN, US, GB" className="border rounded px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 col-span-2">
              Notes <span className="text-xs text-gray-400">(for humans only — never parsed by an agent)</span>
              <textarea name="policyNotes" rows={2} maxLength={500} defaultValue={policy?.policyNotes ?? ""} className="border rounded px-3 py-2" />
            </label>
          </div>

          <button type="submit" className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
            Save policy
          </button>
        </form>
      </section>
    </main>
  );
}
