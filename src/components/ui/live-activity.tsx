"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * One dashboard-wide connection to the real decision stream.
 *
 * The stream itself is Layer 15-3's /api/dashboard/decisions/stream: a
 * poll of this merchant's own audit_log rows, cookie-authenticated,
 * emitting only when a row was genuinely written. Nothing in this file
 * fabricates an event, and there is no synthetic heartbeat standing in
 * for activity — if the agent is idle, the feed is quiet, which is
 * itself true information.
 *
 * Why a context rather than an EventSource per component: the toast
 * feed and the nav pulse both want the same events, and two
 * EventSources would mean two Postgres polls per interval per open tab
 * for identical data. One connection fans out here.
 */

export interface LiveDecision {
  id: string;
  decision: string;
  event: string;
  reason: string;
  boundApplied: string | null;
  actor: string;
  createdAt: string;
  moneyAction: { id: string; amountPaise: number; type: string } | null;
}

export type StreamStatus = "connecting" | "live" | "offline";

interface LiveActivityValue {
  status: StreamStatus;
  /** Newest first. Bounded — this is a live ticker, not a second audit trail. */
  recent: LiveDecision[];
  /** Total events seen since this page loaded. Drives the nav pulse. */
  seenCount: number;
  /** Monotonically increasing id of the most recent arrival, for animation keys. */
  lastArrivalAt: number | null;
  dismiss: (id: string) => void;
}

const MAX_RETAINED = 30;

const LiveActivityContext = createContext<LiveActivityValue>({
  status: "connecting",
  recent: [],
  seenCount: 0,
  lastArrivalAt: null,
  dismiss: () => {},
});

export function useLiveActivity() {
  return useContext(LiveActivityContext);
}

export function LiveActivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamStatus>(() =>
    typeof EventSource === "undefined" ? "offline" : "connecting",
  );
  const [recent, setRecent] = useState<LiveDecision[]>([]);
  const [seenCount, setSeenCount] = useState(0);
  const [lastArrivalAt, setLastArrivalAt] = useState<number | null>(null);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    // Degrade honestly rather than pretending: with no EventSource the
    // indicator reads "offline" and every page's own server-rendered
    // data and Refresh button work exactly as before.
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/dashboard/decisions/stream");

    const onOpen = () => setStatus("live");
    const onError = () => {
      // EventSource reconnects by itself; this only stops the indicator
      // claiming "live" while the connection is actually down.
      setStatus((prev) => (prev === "live" ? "connecting" : prev));
    };
    const onDecision = (event: MessageEvent<string>) => {
      let entry: LiveDecision;
      try {
        entry = JSON.parse(event.data) as LiveDecision;
      } catch {
        // A malformed frame is a bug worth knowing about, but it must
        // never take the stream down with it.
        console.error("[live-activity] could not parse stream frame");
        return;
      }
      if (seenIds.current.has(entry.id)) return;
      seenIds.current.add(entry.id);
      setRecent((prev) => [entry, ...prev].slice(0, MAX_RETAINED));
      setSeenCount((n) => n + 1);
      setLastArrivalAt(Date.now());
      setStatus("live");
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("decision", onDecision);

    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener("decision", onDecision);
      source.close();
    };
  }, []);

  const value = useMemo<LiveActivityValue>(
    () => ({
      status,
      recent,
      seenCount,
      lastArrivalAt,
      dismiss: (id: string) => setRecent((prev) => prev.filter((e) => e.id !== id)),
    }),
    [status, recent, seenCount, lastArrivalAt],
  );

  return <LiveActivityContext.Provider value={value}>{children}</LiveActivityContext.Provider>;
}
