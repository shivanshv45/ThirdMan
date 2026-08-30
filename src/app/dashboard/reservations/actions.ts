"use server";

import { sweepAbandonedReservations } from "@/lib/gate";

/**
 * Called on page load, mirroring escrow's sweepOnLoad — sweeps anything
 * past its reservationExpiresAt before rendering, so a stranded
 * reservation never lingers as "held" on screen just because a merchant
 * happened to load the page before the next cron tick. Unlike
 * sweepExpiredHolds, this sweep is not merchant-scoped (money_actions has
 * no merchant filter in the query — the same shape drainDueTasks/
 * sweepAllAgents already use across the whole table), so this is safe
 * to call from any merchant's dashboard load.
 */
export async function sweepOnLoad() {
  return sweepAbandonedReservations();
}
