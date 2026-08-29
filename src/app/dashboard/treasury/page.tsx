import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getTreasuryOverview } from "@/lib/treasury";
import { listRewardRules } from "@/lib/reward-rules";
import { getUseCaseBudgetStatus, getRoutingSavings, type ModelUseCase } from "@/lib/model-router";
import { getRecentTreasuryLedgerEntries } from "@/lib/dashboard";
import { PageHeader, Surface, MoneyStat, Stat, Field, Input, Select, Button, EmptyState, Table, Thead, Tr, Th, Td } from "@/components/ui";
import {
  saveTreasurySettings,
  createRewardRule,
  toggleRewardRule,
  removeRewardRule,
  draftRewardRule,
  approveDraftedRuleAction,
  saveModelBudget,
} from "./actions";

const USE_CASES: { value: ModelUseCase; label: string }[] = [
  { value: "support_chat", label: "Support chat" },
  { value: "recovery_diagnosis", label: "Recovery diagnosis" },
  { value: "negotiation", label: "Negotiation" },
  { value: "classification", label: "Classification" },
];

const FIELD_OPTIONS = [
  { value: "orderValuePaise", label: "Order value (₹)" },
  { value: "marginPercent", label: "Margin (%)" },
  { value: "priorCaptureCount", label: "Prior purchases" },
];

const OPERATOR_OPTIONS = [
  { value: "gt", label: "is above" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is below" },
  { value: "lte", label: "is at most" },
  { value: "eq", label: "equals" },
];

const BUCKET_LABELS: Record<string, string> = {
  buyer_credits: "Buyer credits",
  merchant_ai_budget: "Merchant AI budget",
  reserve: "Reserve",
};

const REASON_LABELS: Record<string, string> = {
  capture_allocation: "Capture allocation",
  model_spend: "Model spend",
  buyer_credit_funding: "Buyer credit funding",
};

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Layer 14-5: the AI Treasury dashboard. Every figure here is a real
 * query over treasury_ledger/model_call_costs/reward_rules — nothing
 * rendered is a sample or an estimate (CLAUDE.md's "no fabricated data"
 * design rule). The allocation mechanism itself is honestly framed as
 * this project's own configurable simulation, not a claim about
 * Razorpay's real fee structure — see DECISIONS.md.
 */
export default async function TreasuryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; draft?: string; draftDescription?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error, draft, draftDescription } = await searchParams;

  const [overview, rules, ledgerEntries, budgetStatuses, savings] = await Promise.all([
    getTreasuryOverview(merchant.id),
    listRewardRules(merchant.id),
    getRecentTreasuryLedgerEntries(merchant.id, 30),
    Promise.all(USE_CASES.map((uc) => getUseCaseBudgetStatus(merchant.id, uc.value))),
    getRoutingSavings(merchant.id),
  ]);

  const settings = overview.settings;

  return (
    <div className="space-y-8">
      <PageHeader
        title="AI Treasury"
        description="A merchant-set share of successful GMV funds a pool split between buyer AI credits, your own AI operating budget, and a reserve. This is a configurable product mechanism demonstrated with this project's own numbers — not a claim about Razorpay's real fees or economics."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      <Surface variant="raised" className="p-6">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-4">Pool balance</h2>
        <div className="grid grid-cols-3 gap-6">
          <MoneyStat label="Buyer credits" paise={overview.buyerCreditsPaise} size="primary" />
          <MoneyStat label="Merchant AI budget" paise={overview.merchantAiBudgetPaise} tone="accent" size="primary" />
          <MoneyStat label="Reserve" paise={overview.reservePaise} size="primary" />
        </div>
        <p className="text-xs text-on-ink-faint mt-4">
          Every figure above is the real sum of treasury_ledger rows for this merchant — funded only on a genuine captured payment, never a hold or an authorization.
        </p>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">{settings ? "Allocation policy" : "The Treasury is not enabled"}</h2>
        <p className="text-sm text-on-ink-dim mb-4 max-w-[var(--measure)]">
          {settings
            ? "How much of a captured purchase funds the pool, and how that contribution splits three ways. Shares must total 100%."
            : "No allocation configured yet. Set a rate and split below to turn the Treasury on."}
        </p>
        <form action={saveTreasurySettings} className="space-y-4 max-w-sm">
          <Field label="Allocation rate (% of captured GMV)">
            <Input
              name="allocationPercent"
              type="number"
              step="0.01"
              min="0"
              max="100"
              required
              defaultValue={settings ? (settings.allocationBasisPoints / 100).toFixed(2) : ""}
            />
          </Field>
          <Field label="Buyer credits share (% of the contribution)">
            <Input name="buyerPercent" type="number" step="0.01" min="0" max="100" required defaultValue={settings ? (settings.buyerShareBps / 100).toFixed(2) : ""} />
          </Field>
          <Field label="Merchant AI budget share (%)">
            <Input name="merchantPercent" type="number" step="0.01" min="0" max="100" required defaultValue={settings ? (settings.merchantShareBps / 100).toFixed(2) : ""} />
          </Field>
          <Field label="Reserve share (%)" help="The three shares above must sum to exactly 100%.">
            <Input name="reservePercent" type="number" step="0.01" min="0" max="100" required defaultValue={settings ? (settings.reserveShareBps / 100).toFixed(2) : ""} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-on-ink">
            <input type="checkbox" name="enabled" defaultChecked={settings?.enabled ?? false} className="accent-[var(--accent-bright)]" />
            Enabled
          </label>
          <Button type="submit" variant="primary" pendingLabel="Saving…">
            {settings ? "Save" : "Enable the Treasury"}
          </Button>
        </form>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">Margin-aware reward rules</h2>
        <p className="text-sm text-on-ink-dim mb-4 max-w-[var(--measure)]">
          A multiplier applied to coin issuance when a purchase&apos;s real order value, margin, or return-buyer status matches. The first matching rule wins. No rule ever executes model-generated code — every rule is validated against a fixed, typed grammar before it can be stored.
        </p>

        {rules.length === 0 ? (
          <EmptyState title="No rules yet" description="Add one below, or draft one from a plain-English instruction." />
        ) : (
          <div className="space-y-2 mb-5">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-ink-line px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-on-ink">{rule.description}</p>
                  <p className="text-xs text-on-ink-faint font-mono mt-0.5">
                    priority {rule.priority} · {rule.source === "llm_drafted" ? "LLM-drafted, merchant-approved" : "merchant-authored"}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <form action={toggleRewardRule}>
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                    <Button type="submit" variant={rule.enabled ? "secondary" : "primary"} size="sm" pendingLabel="Saving…">
                      {rule.enabled ? "Disable" : "Enable"}
                    </Button>
                  </form>
                  <form action={removeRewardRule}>
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <Button type="submit" variant="secondary" size="sm" pendingLabel="Removing…">
                      Remove
                    </Button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}

        <form action={createRewardRule} className="space-y-3 max-w-md border-t border-ink-line-soft pt-4">
          <p className="text-xs uppercase tracking-[0.06em] text-on-ink-faint font-medium">Add a rule directly</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Field">
              <Select name="field" required>
                {FIELD_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Comparison">
              <Select name="operator" required>
                {OPERATOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Value">
              <Input name="value" type="number" step="0.01" required />
            </Field>
            <Field label="Multiplier (x)">
              <Input name="multiplierX" type="number" step="0.1" min="0" required defaultValue="2" />
            </Field>
          </div>
          <Field label="Priority (lower runs first)">
            <Input name="priority" type="number" step="1" defaultValue="0" />
          </Field>
          <Button type="submit" variant="secondary" pendingLabel="Adding…">
            Add rule
          </Button>
        </form>

        <form action={draftRewardRule} className="space-y-3 max-w-md border-t border-ink-line-soft pt-4 mt-4">
          <p className="text-xs uppercase tracking-[0.06em] text-on-ink-faint font-medium">Or describe it in plain English</p>
          <Field label="Instruction" help="An LLM drafts a candidate rule; nothing activates until you review and approve it below.">
            <Input name="instruction" type="text" placeholder="Give returning customers 2x credits when order value is above ₹500" />
          </Field>
          <Button type="submit" variant="secondary" pendingLabel="Drafting…">
            Draft rule
          </Button>
        </form>

        {draft && draftDescription && (
          <div className="mt-4 rounded-[var(--radius)] border border-ink-line bg-accent-wash px-4 py-3 max-w-md">
            <p className="text-xs uppercase tracking-[0.06em] text-on-ink-faint font-medium mb-1">Drafted rule — review before approving</p>
            <p className="text-sm text-on-ink mb-3">{draftDescription}</p>
            <form action={approveDraftedRuleAction} className="flex items-center gap-2">
              <input type="hidden" name="astJson" value={draft} />
              <input type="hidden" name="priority" value="0" />
              <Button type="submit" variant="primary" size="sm" pendingLabel="Approving…">
                Approve and activate
              </Button>
            </form>
          </div>
        )}
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">Model budgets and routing savings</h2>
        <p className="text-sm text-on-ink-dim mb-4 max-w-[var(--measure)]">
          Per-use-case allocations from the merchant AI budget bucket. A use case whose budget is exhausted degrades to the cheapest known model rather than overspending.
        </p>

        <div className="grid grid-cols-2 gap-4 mb-5">
          <Stat label="Actual routing cost" value={`₹${(savings.actualCostPaise / 100).toFixed(2)}`} />
          <Stat label="Saved vs. premium tier" value={`₹${(savings.savedPaise / 100).toFixed(2)}`} tone="allow" caption={`${savings.callCount} real calls`} />
        </div>

        <div className="space-y-2">
          {budgetStatuses.map((status) => (
            <div key={status.useCase} className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-ink-line px-4 py-3">
              <div>
                <p className="text-sm text-on-ink">{USE_CASES.find((u) => u.value === status.useCase)?.label}</p>
                <p className="text-xs text-on-ink-faint font-mono mt-0.5">
                  {status.configured ? `₹${(status.spentPaise / 100).toFixed(2)} spent of ₹${(status.budgetPaise / 100).toFixed(2)}` : "not configured — degrades to the cheapest tier"}
                </p>
              </div>
              <form action={saveModelBudget} className="flex items-center gap-2 shrink-0">
                <input type="hidden" name="useCase" value={status.useCase} />
                <Input name="budgetRupees" type="number" step="0.01" min="0" defaultValue={(status.budgetPaise / 100).toFixed(2)} className="w-28" />
                <Button type="submit" variant="secondary" size="sm" pendingLabel="Saving…">
                  Save
                </Button>
              </form>
            </div>
          ))}
        </div>
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-4">Ledger</h2>
        {ledgerEntries.length === 0 ? (
          <EmptyState title="No treasury activity yet" description="Entries appear here the first time a captured purchase funds the pool." />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Bucket</Th>
                <Th>Reason</Th>
                <Th numeric>Amount</Th>
                <Th>When</Th>
              </Tr>
            </Thead>
            <tbody>
              {ledgerEntries.map((entry) => (
                <Tr key={entry.id}>
                  <Td>{BUCKET_LABELS[entry.bucket] ?? entry.bucket}</Td>
                  <Td>{REASON_LABELS[entry.reason] ?? entry.reason}</Td>
                  <Td numeric className={entry.amountPaise < 0 ? "text-deny-bright" : "text-allow-bright"}>
                    {entry.amountPaise < 0 ? "-" : "+"}₹{(Math.abs(entry.amountPaise) / 100).toFixed(2)}
                  </Td>
                  <Td>{formatDate(entry.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Surface>
    </div>
  );
}
