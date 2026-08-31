"use client";

import { useEffect, useState } from "react";
import { useLiveActivity } from "./live-activity";

/**
 * The persistent "the gate is watching" indicator in the top nav.
 *
 * Three honest states, and no fourth that fakes activity:
 *  - live      : the stream is connected. A slow ambient pulse.
 *  - connecting: opened or dropped, EventSource is retrying.
 *  - offline   : no EventSource at all. Says so rather than idling green.
 *
 * The sharp flare fires only when a real decision arrives, so movement
 * in the nav always means a row was actually written.
 */
export function LivePulse() {
  const { status, seenCount, lastArrivalAt } = useLiveActivity();
  const [flare, setFlare] = useState(false);

  useEffect(() => {
    if (lastArrivalAt === null) return;
    setFlare(true);
    const t = setTimeout(() => setFlare(false), 900);
    return () => clearTimeout(t);
  }, [lastArrivalAt]);

  const label =
    status === "live"
      ? seenCount > 0
        ? `Live — ${seenCount} decision${seenCount === 1 ? "" : "s"} this session`
        : "Live — watching for decisions"
      : status === "connecting"
        ? "Reconnecting to the decision stream"
        : "Live updates unavailable — pages still refresh normally";

  const color =
    status === "live" ? "var(--allow)" : status === "connecting" ? "var(--escalate)" : "var(--on-ink-faint)";

  return (
    <span
      className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] border border-ink-line bg-ink-overlay/60 px-2.5 py-1"
      title={label}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {status === "live" && (
          <span
            className={`absolute inset-0 rounded-full ${flare ? "live-pulse-flare" : "live-pulse-ambient"}`}
            style={{ background: color }}
          />
        )}
        <span className="relative h-2 w-2 rounded-full" style={{ background: color }} />
      </span>
      <span className="text-[11px] font-medium text-on-ink-dim tabular-nums">
        {status === "live" ? (seenCount > 0 ? seenCount : "Live") : status === "connecting" ? "…" : "Off"}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
