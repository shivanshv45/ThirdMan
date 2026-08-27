import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";
import { setMerchantPolicy } from "./actions";
import { PageHeader, Surface, Field, Input, Select, Button } from "@/components/ui";

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
    <div className="space-y-8">
      <PageHeader
        title="Policies"
        description="Return, refund, and shipping terms — structured so an AI buyer can act on them, not just read them. A cautious agent that can't determine your return window may skip you."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-2">Current policy (as an agent would read it)</h2>
        <p className="text-sm text-on-ink bg-ink-overlay border border-ink-line-soft rounded-[var(--radius)] px-3 py-2 font-mono">
          {describeMerchantPolicy(policy)}
        </p>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-3">Edit</h2>
        <form action={setMerchantPolicy} className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-on-ink-dim">
            <input type="checkbox" name="returnsAccepted" defaultChecked={policy?.returnsAccepted ?? false} />
            Accept returns
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Return window (days)">
              <Input name="returnWindowDays" type="number" min="0" step="1" defaultValue={policy?.returnWindowDays ?? ""} />
            </Field>
            <Field label="Refund method">
              <Select name="refundMethod" defaultValue={policy?.refundMethod ?? ""}>
                <option value="">Not specified</option>
                <option value="original_payment_method">Original payment method</option>
                <option value="store_credit">Store credit</option>
                <option value="either">Either</option>
              </Select>
            </Field>
            <Field label="Restocking fee (%)">
              <Input name="restockingFeePercent" type="number" min="0" max="100" step="1" defaultValue={policy?.restockingFeePercent ?? ""} />
            </Field>
            <Field label="Handling time (days)">
              <Input name="handlingTimeDays" type="number" min="0" step="1" defaultValue={policy?.handlingTimeDays ?? ""} />
            </Field>
            <Field label="Warranty (months)">
              <Input name="warrantyMonths" type="number" min="0" step="1" defaultValue={policy?.warrantyMonths ?? ""} />
            </Field>
            <div className="col-span-2">
              <Field label="Ships to (comma-separated region/country codes)">
                <Input name="shippingRegions" defaultValue={policy?.shippingRegions?.join(", ") ?? ""} placeholder="IN, US, GB" />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Notes" help="For humans only — never parsed by an agent">
                <textarea
                  name="policyNotes"
                  rows={2}
                  maxLength={500}
                  defaultValue={policy?.policyNotes ?? ""}
                  className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
                />
              </Field>
            </div>
          </div>

          <Button type="submit" variant="primary" pendingLabel="Saving…">
            Save policy
          </Button>
        </form>
      </Surface>
    </div>
  );
}
