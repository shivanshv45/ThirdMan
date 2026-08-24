import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getEscrowHolds, getProducts } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import { ESCROW_HOLD_EXPIRY_HOURS } from "@/lib/gate";
import { releaseHold, refundHold, sweepOnLoad } from "./actions";
import { CreateHoldForm } from "./create-hold";

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
  const activeProducts = products.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name, pricePaise: p.pricePaise }));

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Escrow</h1>
        <p className="text-sm text-gray-500">
          Hold-and-capture: a payment is authorised but not taken until you release it, or refund it back. Any hold left unresolved for {ESCROW_HOLD_EXPIRY_HOURS} hours is auto-refunded — money is never left in limbo.
        </p>
      </header>

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Create a demo hold</h2>
        <p className="text-sm text-gray-500 mb-3">
          Completes a real Razorpay test-mode payment (card details required by the widget), authorised but not captured.
        </p>
        <CreateHoldForm products={activeProducts} />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Holds {holds.length > 0 && `(${holds.length})`}</h2>
        {holds.length === 0 ? (
          <p className="text-sm text-gray-500">No holds yet.</p>
        ) : (
          <div className="space-y-3">
            {holds.map((hold) => (
              <div key={hold.id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{hold.productName ?? "Purchase"}</span>{" "}
                    <span className="text-sm text-gray-500">{rupees(hold.moneyAction.amountPaise)}</span>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      hold.outcome === "held" ? "bg-purple-100 text-purple-800" : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {OUTCOME_LABEL[hold.outcome]}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Created {formatDate(hold.createdAt)} · Expires {formatDate(hold.expiresAt)}
                  {hold.resolvedAt && ` · Resolved ${formatDate(hold.resolvedAt)}`}
                </p>
                {hold.outcome === "held" && (
                  <div className="flex gap-2 mt-3">
                    <form action={releaseHold}>
                      <input type="hidden" name="moneyActionId" value={hold.moneyAction.id} />
                      <button type="submit" className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700">
                        Release (capture)
                      </button>
                    </form>
                    <form action={refundHold}>
                      <input type="hidden" name="moneyActionId" value={hold.moneyAction.id} />
                      <button type="submit" className="text-sm px-3 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50">
                        Refund
                      </button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
