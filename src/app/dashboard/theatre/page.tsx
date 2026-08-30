import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getBuyerAgentRuns, getAuditTrail, verifyMoneyActionIds } from "@/lib/dashboard";
import { PageHeader, EmptyState } from "@/components/ui";
import { TheatrePanel } from "./theatre-panel";

/**
 * Layer 19-5: the Theatre view. The buyer agent's real run log on the
 * left, the merchant's real decision stream on the right, correlated
 * by real money action id — never by timestamp (governing rule,
 * plans/layer-19-adversarial-buyer.md). The buyer agent holds no
 * database access; its side of this view exists only because it
 * streamed its own local log to /api/agent/theatre/ingest (an ordinary
 * agent-authenticated route, no special casing).
 */
export default async function TheatrePage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const runs = await getBuyerAgentRuns(merchant.id);
  const latestRun = runs[0] ?? null;

  const claimedIds = latestRun
    ? [...new Set(latestRun.steps.map((s) => s.moneyActionId).filter((id): id is string => Boolean(id)))]
    : [];
  const verifiedIds = latestRun ? [...(await verifyMoneyActionIds(merchant.id, claimedIds))] : [];

  const decisions = await getAuditTrail(merchant.id, 100);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Theatre"
        description="An autonomous AI buyer agent — external, untrusted, holding nothing but an API key — running against this store live. Its own reasoning on the left; this store's real refusals and approvals on the right. A step and a decision are paired only when the buyer's log names a real money action id this merchant's own audit trail also has."
      />

      {!latestRun ? (
        <EmptyState
          title="No buyer-agent run yet"
          description="Run the standalone agent-buyer/ package against this store (see DEMO.md) — its run log appears here once it uploads."
        />
      ) : (
        <TheatrePanel run={latestRun} verifiedMoneyActionIds={verifiedIds} initialDecisions={decisions} runs={runs} />
      )}
    </div>
  );
}
