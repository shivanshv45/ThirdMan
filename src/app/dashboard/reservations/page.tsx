import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getActiveReservations } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import { RESERVATION_TIMEOUT_MINUTES } from "@/lib/gate";
import { sweepOnLoad } from "./actions";
import { PageHeader, Surface, EmptyState } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function minutesUntil(d: Date): number {
  return Math.max(0, Math.round((new Date(d).getTime() - Date.now()) / 60_000));
}

export default async function ReservationsPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  // Sweep before rendering — same reasoning as escrow's sweepOnLoad: a
  // reservation past its deadline should never show as held just
  // because a merchant loaded this page before the next cron tick.
  await sweepOnLoad();

  const reservations = await getActiveReservations(merchant.id);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reservations"
        description={`Budget and stock currently held by an in-flight purchase attempt, before it settles. Anything left unresolved for ${RESERVATION_TIMEOUT_MINUTES} minutes is automatically released — money and stock are never left locked indefinitely.`}
      />

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">
          Currently held {reservations.length > 0 && <span className="text-on-ink-faint font-mono text-base">({reservations.length})</span>}
        </h2>
        {reservations.length === 0 ? (
          <EmptyState
            title="No reservations held right now"
            description="This is the normal state — a reservation only appears here for the brief window between an agent's purchase being allowed and it settling with Razorpay."
          />
        ) : (
          <div className="space-y-3">
            {reservations.map((r) => (
              <Surface key={r.id} variant="raised" className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span className="font-medium text-on-ink">{r.productName ?? "Purchase"}</span>{" "}
                    <span className="text-sm text-on-ink-dim font-mono">
                      {rupees(r.amountPaise)} × {r.quantity}
                    </span>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-escalate-wash text-escalate-bright">
                    Expires in {minutesUntil(r.reservationExpiresAt)}m
                  </span>
                </div>
                <p className="text-xs text-on-ink-faint mt-1.5 font-mono">
                  Agent {r.agentName ?? "unknown"} · Reserved {formatDate(r.createdAt)} · Auto-releases {formatDate(r.reservationExpiresAt)}
                </p>
              </Surface>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
