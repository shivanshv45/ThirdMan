import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getEscrowHolds, getProducts } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import { ESCROW_HOLD_EXPIRY_HOURS } from "@/lib/gate";
import { releaseHold, refundHold, sweepOnLoad } from "./actions";
import { CreateHoldForm } from "./create-hold";
import { PageHeader, Surface, Button, EmptyState } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const OUTCOME_LABEL: Record<string, string> = {
  held: "Held",
  captured: "Released to you",
  refunded: "Refunded",
  expired_refunded: "Auto-refunded (expired)",
};

export default async function EscrowPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  // Sweep before rendering so an expired hold never shows as "held" —
  // see escrow.ts's sweepExpiredHolds and plans/layer-4-front-door.md's
  // "a hold that is never resolved is money in limbo."
  await sweepOnLoad(merchant.id);

  const [holds, products] = await Promise.all([getEscrowHolds(merchant.id), getProducts(merchant.id)]);
  const activeProducts = products
    .filter((p) => p.status === "active")
    .flatMap((p) => {
      const variant = p.variants.find((v) => v.status === "active");
      return variant ? [{ id: p.id, name: p.name, pricePaise: variant.pricePaise }] : [];
    });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Escrow"
        description={`Hold-and-capture: a payment is authorised but not taken until you release it, or refund it back. Any hold left unresolved for ${ESCROW_HOLD_EXPIRY_HOURS} hours is auto-refunded — money is never left in limbo.`}
      />

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1.5">Create a demo hold</h2>
        <p className="text-sm text-on-ink-dim mb-3 max-w-[var(--measure)]">
          Completes a real Razorpay test-mode payment (card details required by the widget), authorised but not captured.
        </p>
        <CreateHoldForm products={activeProducts} />
      </Surface>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">
          Holds {holds.length > 0 && <span className="text-on-ink-faint font-mono text-base">({holds.length})</span>}
        </h2>
        {holds.length === 0 ? (
          <EmptyState title="No holds yet" description="Create one above to see the hold-and-capture flow." />
        ) : (
          <div className="space-y-3">
            {holds.map((hold) => (
              <Surface key={hold.id} variant="raised" className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span className="font-medium text-on-ink">{hold.productName ?? "Purchase"}</span>{" "}
                    <span className="text-sm text-on-ink-dim font-mono">{rupees(hold.moneyAction.amountPaise)}</span>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      hold.outcome === "held" ? "bg-escalate-wash text-escalate-bright" : "bg-ink-overlay text-on-ink-faint"
                    }`}
                  >
                    {OUTCOME_LABEL[hold.outcome]}
                  </span>
                </div>
                <p className="text-xs text-on-ink-faint mt-1.5 font-mono">
                  Created {formatDate(hold.createdAt)} · Expires {formatDate(hold.expiresAt)}
                  {hold.resolvedAt && ` · Resolved ${formatDate(hold.resolvedAt)}`}
                </p>
                {hold.outcome === "held" && (
                  <div className="flex gap-2 mt-3">
                    <form action={releaseHold}>
                      <input type="hidden" name="moneyActionId" value={hold.moneyAction.id} />
                      <Button type="submit" variant="primary" size="sm" pendingLabel="Releasing…">
                        Release (capture)
                      </Button>
                    </form>
                    <form action={refundHold}>
                      <input type="hidden" name="moneyActionId" value={hold.moneyAction.id} />
                      <Button type="submit" variant="destructive" size="sm" pendingLabel="Refunding…">
                        Refund
                      </Button>
                    </form>
                  </div>
                )}
              </Surface>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
