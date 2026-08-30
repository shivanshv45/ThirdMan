import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getOpenReturnRequests } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import { approveReturnRequestAction, rejectReturnRequestAction } from "../actions";
import { PageHeader, Surface, EmptyState, Button, Field, Input } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const RECOMMENDATION_LABEL: Record<string, string> = {
  approve: "Recommends: approve",
  reject: "Recommends: reject",
  needs_merchant_judgement: "No clear recommendation",
};

export default async function ReturnsPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const requests = await getOpenReturnRequests(merchant.id);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Returns desk"
        description="An AI conducts the conversation and drafts a recommendation. It never decides — every approval below is your own click, and it's the only thing that ever issues a refund."
      />

      {requests.length === 0 ? (
        <EmptyState
          title="No return requests awaiting you"
          description="A request lands here only once a buyer's conversation with the returns desk is complete and the deterministic checks (purchase ownership, capture status, return window, no duplicate) have already passed."
        />
      ) : (
        <div className="space-y-4">
          {requests.map((r) => (
            <Surface key={r.id} variant="raised" className="p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <span className="font-medium text-on-ink">{r.requesterLabel}</span>{" "}
                  <span className="text-sm text-on-ink-dim font-mono">
                    Purchase {rupees(r.moneyAction.amountPaise)} · refundable up to {rupees(r.refundableAmountPaise)}
                  </span>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-escalate-wash text-escalate-bright">
                  Expires {formatDate(r.expiresAt)}
                </span>
              </div>

              <div className="rounded-[var(--radius)] border border-ink-line bg-ink-overlay p-3">
                <p className="text-xs uppercase tracking-[0.08em] text-on-ink-faint mb-1">Buyer&apos;s stated reason</p>
                <p className="text-sm text-on-ink-dim">&ldquo;{r.statedReason}&rdquo;</p>
              </div>

              {r.messages.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-on-ink-dim hover:text-on-ink">Full conversation ({r.messages.length} messages)</summary>
                  <div className="mt-2 space-y-1.5">
                    {r.messages.map((m, i) => (
                      <p key={i} className="text-xs text-on-ink-faint">
                        <span className="font-medium text-on-ink-dim">{m.role === "buyer" ? "Buyer" : "Desk"}:</span> {m.content}
                      </p>
                    ))}
                  </div>
                </details>
              )}

              {r.modelSummary ? (
                <div className="rounded-[var(--radius)] border border-accent/30 bg-accent/5 p-3 space-y-1">
                  <p className="text-xs uppercase tracking-[0.08em] text-accent">Generated summary — not a fact, a draft</p>
                  <p className="text-sm text-on-ink-dim">{r.modelSummary}</p>
                  <p className="text-xs font-medium text-on-ink">{RECOMMENDATION_LABEL[r.modelRecommendation ?? "needs_merchant_judgement"]}</p>
                  {r.modelReasoning && <p className="text-xs text-on-ink-faint">{r.modelReasoning}</p>}
                </div>
              ) : (
                <p className="text-xs text-on-ink-faint italic">No recommendation was generated — decide from the conversation above.</p>
              )}

              <div className="flex items-end gap-3 flex-wrap pt-1">
                <form action={approveReturnRequestAction} className="flex items-end gap-2">
                  <input type="hidden" name="returnRequestId" value={r.id} />
                  <Field label="Refund amount (₹)" help={`Up to ${rupees(r.refundableAmountPaise)}`}>
                    <Input
                      type="number"
                      name="amountRupees"
                      step="0.01"
                      min="0.01"
                      max={r.refundableAmountPaise / 100}
                      placeholder={(r.refundableAmountPaise / 100).toFixed(2)}
                      className="w-32"
                    />
                  </Field>
                  <Button type="submit" variant="primary" size="sm" pendingLabel="Refunding…">
                    Approve &amp; refund
                  </Button>
                </form>
                <form action={rejectReturnRequestAction} className="flex items-end gap-2">
                  <input type="hidden" name="returnRequestId" value={r.id} />
                  <Field label="Reason (shown to the buyer)">
                    <Input type="text" name="reason" placeholder="Outside policy, item as described, etc." className="w-64" />
                  </Field>
                  <Button type="submit" variant="destructive" size="sm" pendingLabel="Rejecting…">
                    Reject
                  </Button>
                </form>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
