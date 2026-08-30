import { notFound } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getDecisionById } from "@/lib/explainability";
import { resolveShareToken } from "@/lib/decision-share";
import { PageHeader, Surface, DecisionBadge } from "@/components/ui";
import { ShareLinkPanel } from "./share-link-panel";
import { ReceiptPanel } from "./receipt-panel";

/**
 * Layer 25-4: the decision permalink. Renders the same real, recorded
 * explanation explainability.ts already assembles — this file adds no
 * new fact, just a shareable route over one it already reads.
 *
 * Access is merchant-scoped by default: a decision is not public data.
 * The one exception is an explicit ?share=<token> a merchant generated
 * for THIS decision (decision-share.ts) — a token that resolves to a
 * different decision than :id, or that doesn't resolve at all, is
 * treated identically to a wrong id (notFound()), never a partial
 * reveal. No costPaise, no PII is ever in a UnifiedDecision's shape —
 * see cost-paise-never-leaks.test.ts's existing coverage of
 * getDecisionById, extended for this route.
 */
export default async function DecisionPermalinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ share?: string }>;
}) {
  const { id } = await params;
  const { share } = await searchParams;

  const merchant = await getSessionMerchant();

  let merchantId: string | null = null;
  let viaShareToken = false;

  if (merchant) {
    merchantId = merchant.id;
  } else if (share) {
    const resolved = await resolveShareToken(share);
    // The token must resolve AND point at exactly this decision id —
    // a valid token for a different decision never leaks this one.
    if (resolved && resolved.auditLogId === id) {
      merchantId = resolved.merchantId;
      viaShareToken = true;
    }
  }

  if (!merchantId) notFound();

  const decision = await getDecisionById(merchantId, id);
  if (!decision) notFound();

  return (
    <div className="min-h-screen bg-ink">
      <div className="max-w-[var(--shell)] mx-auto px-4 md:px-8 py-10 space-y-8">
        <PageHeader
          title="Decision record"
          description="One decision this system made — the real reason, the bound that applied, and the exact arithmetic behind it, exactly as recorded in the audit trail."
        />

        <Surface variant="raised" className="p-6 space-y-4">
          <div className="flex items-center gap-2.5 flex-wrap">
            <DecisionBadge decision={decision.kind === "refusal" ? "deny" : "escalate"} label={decision.kind === "refusal" ? "Refused" : "Deferred to merchant"} />
            <span
              className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                decision.determinism === "deterministic" ? "bg-allow-wash text-allow-bright" : "bg-accent-wash text-accent-bright"
              }`}
            >
              {decision.determinism === "deterministic" ? "Arithmetic, no model" : "A model's judgment"}
            </span>
            <span className="text-xs text-on-ink-faint font-mono">{new Date(decision.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
          </div>

          <div>
            <div className="text-[var(--t-h4)] font-medium text-on-ink">{decision.boundLabel}</div>
            <p className="text-sm text-on-ink-dim mt-1">{decision.reason}</p>
          </div>

          {decision.arithmetic.length > 0 && (
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 border-t border-ink-line-soft text-xs">
              {decision.arithmetic.map((a) => (
                <div key={a.label}>
                  <dt className="text-on-ink-faint">{a.label}</dt>
                  <dd className="font-mono text-on-ink mt-0.5">{a.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {decision.agentName && (
            <p className="text-xs text-on-ink-faint pt-2 border-t border-ink-line-soft">
              Agent: <span className="text-on-ink-dim">{decision.agentName}</span>
            </p>
          )}
        </Surface>

        {decision.sourceRef.table === "audit_log" && (
          <ReceiptPanel decisionId={decision.id} merchantId={merchantId} isMerchantSession={!!merchant} />
        )}

        {!viaShareToken && merchant && <ShareLinkPanel decisionId={decision.id} />}

        {viaShareToken && (
          <p className="text-xs text-on-ink-faint text-center">
            This is a shared, read-only view of one decision. No other data from this merchant is visible here.
          </p>
        )}
      </div>
    </div>
  );
}
