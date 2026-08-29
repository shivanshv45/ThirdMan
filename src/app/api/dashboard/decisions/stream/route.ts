import { NextRequest } from "next/server";
import { getSessionMerchant } from "@/lib/auth";
import { getAuditTrail } from "@/lib/dashboard";
import type { AuditEntry } from "@/app/dashboard/actions";

// Node runtime, not edge — this polls the real Postgres audit_log via
// the same db client every other dashboard read uses.
export const runtime = "nodejs";

/**
 * Layer 15-3: the live decision stream. No new dependency — Server-Sent
 * Events are a plain text/event-stream Response, native to the
 * platform. Mechanism is a short interval poll against audit_log,
 * scoped by merchantId exactly like every other dashboard read
 * (getAuditTrail) — not Postgres LISTEN/NOTIFY, which postgres-js
 * supports but would add a second connection-lifecycle concern to
 * db/index.ts's shared client for a demo-scale feature the plan
 * explicitly says to keep simple. An event only ever reaches the
 * client because a real row was written; nothing here is simulated.
 *
 * Auth: the same getSessionMerchant() cookie check every dashboard page
 * uses — an SSE endpoint is an authorization surface like any other
 * (plan's own requirement). The client (EventSource) sends cookies
 * automatically on same-origin requests, so no separate token scheme
 * is needed.
 */

const POLL_INTERVAL_MS = 2500;
// A ring buffer read each tick is cheap at this scale (one merchant's
// own recent rows) — bounded so a burst of activity can't balloon a
// single SSE payload.
const MAX_EVENTS_PER_TICK = 25;

export async function GET(req: NextRequest) {
  const merchant = await getSessionMerchant();
  if (!merchant) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let lastSeenCreatedAt = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // A comment line keeps the connection alive through proxies that
      // buffer on the first byte, and lets the client confirm it connected.
      controller.enqueue(encoder.encode(": connected\n\n"));

      const tick = async () => {
        if (closed) return;
        try {
          const recent = await getAuditTrail(merchant.id, MAX_EVENTS_PER_TICK);
          const fresh = recent.filter((e: AuditEntry) => new Date(e.createdAt) > lastSeenCreatedAt);
          if (fresh.length > 0) {
            // Oldest first, so the client can append in the same order
            // the existing Refresh-fetched list is already sorted.
            for (const entry of [...fresh].reverse()) {
              send("decision", entry);
            }
            lastSeenCreatedAt = new Date(recent[0].createdAt);
          }
        } catch (err) {
          // A poll failing must never crash the stream — the client's
          // reconnect-on-drop handles a genuinely dead connection; a
          // transient DB hiccup just skips this tick.
          console.error("[decisions/stream] poll failed:", err);
        }
      };

      const interval = setInterval(tick, POLL_INTERVAL_MS);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // Already closed — a race between abort and a pending enqueue.
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
