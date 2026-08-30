import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getMerchantAgentTerms } from "@/lib/agent-terms";
import { setAgentTerms } from "./actions";
import { PageHeader, Surface, Field, Input, Button } from "@/components/ui";
import { schema } from "@/lib/db";

const CAPABILITY_LABELS: Record<(typeof schema.agentCapabilityEnum.enumValues)[number], string> = {
  "products:read": "Read the catalogue",
  "policy:read": "Read return/refund policy",
  "offers:read": "Read upsell offers",
  "rewards:read": "Read reward-coin balance",
  "rewards:redeem": "Redeem reward coins",
  "negotiation:create": "Negotiate a price",
  "purchase:create": "Make a purchase",
};

function rupeesValue(paise: number | null): number | "" {
  return paise === null ? "" : paise / 100;
}

export default async function AgentTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;
  const terms = await getMerchantAgentTerms(merchant.id);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Agent terms"
        description="The rules under which this merchant is willing to sell to a machine at all — as a class, not per agent. Every field here is arithmetic or a boolean, enforced in the gate exactly like a spend cap. Publishing nothing here means unknown agents cannot self-register and self-registration stays closed."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      {!terms && (
        <Surface variant="raised" className="p-5">
          <p className="text-sm text-on-ink-dim">
            No agent terms published yet. Absence is not a permissive default — self-registration is closed, and an agent with no completed purchase history from a self-registration flow cannot transact, until you save terms below.
          </p>
        </Surface>
      )}

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-3">Unknown agents</h2>
        <form action={setAgentTerms} className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-on-ink-dim">
            <input type="checkbox" name="unknownAgentsAllowed" defaultChecked={terms?.unknownAgentsAllowed ?? false} />
            Allow a self-registered agent with no completed purchase history to transact at all
          </label>

          <Field label="Order ceiling for a self-registered agent with no history (₹)" help="Applied on top of the agent's own per-transaction max — the stricter of the two applies. Leave blank for no extra ceiling.">
            <Input name="newAgentOrderCeilingRupees" type="number" step="0.01" min="0" defaultValue={rupeesValue(terms?.newAgentOrderCeilingPaise ?? null)} />
          </Field>

          <Field label="Require a verified AP2 Payment Mandate above this order value (₹)" help="Applies to every agent, merchant-issued or self-registered. Leave blank for no value-based mandate requirement.">
            <Input name="mandateRequiredAboveRupees" type="number" step="0.01" min="0" defaultValue={rupeesValue(terms?.mandateRequiredAbovePaise ?? null)} />
          </Field>

          <label className="flex items-center gap-2 text-sm text-on-ink-dim">
            <input type="checkbox" name="negotiationOpenToAgents" defaultChecked={terms?.negotiationOpenToAgents ?? false} />
            Allow negotiation to be part of a self-registered agent&apos;s default capability set
          </label>

          <div className="pt-4 border-t border-ink-line-soft">
            <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">Self-registration</h2>
            <p className="text-sm text-on-ink-faint mb-3">
              Closed by default. Opening it requires a starting cap and a per-transaction max below — a provisional agent with purchase:create and no cap is a gap, not a choice.
            </p>

            <label className="flex items-center gap-2 text-sm text-on-ink-dim mb-3">
              <input type="checkbox" name="selfRegistrationOpen" defaultChecked={terms?.selfRegistrationOpen ?? false} />
              Open POST /api/agent/register
            </label>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <Field label="Starting cap (₹)">
                <Input name="selfRegisterStartingCapRupees" type="number" step="0.01" min="0" defaultValue={rupeesValue(terms?.selfRegisterStartingCapPaise ?? null)} />
              </Field>
              <Field label="Per-transaction max (₹)">
                <Input name="selfRegisterPerTransactionMaxRupees" type="number" step="0.01" min="0" defaultValue={rupeesValue(terms?.selfRegisterPerTransactionMaxPaise ?? null)} />
              </Field>
            </div>

            <p className="text-sm text-on-ink-dim mb-2">Default capabilities granted at registration</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {Object.entries(CAPABILITY_LABELS).map(([capability, label]) => (
                <label key={capability} className="flex items-center gap-2 text-sm text-on-ink-dim">
                  <input
                    type="checkbox"
                    name="selfRegisterDefaultCapabilities"
                    value={capability}
                    defaultChecked={terms?.selfRegisterDefaultCapabilities?.includes(capability as (typeof schema.agentCapabilityEnum.enumValues)[number]) ?? false}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <Button type="submit" variant="primary" pendingLabel="Saving…">
            Save agent terms
          </Button>
        </form>
      </Surface>
    </div>
  );
}
