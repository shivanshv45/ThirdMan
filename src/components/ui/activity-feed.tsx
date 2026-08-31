"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldX, ShieldAlert, Activity, ChevronDown, X, Radio } from "lucide-react";
import { formatPaise } from "@/lib/money";
import { useLiveActivity, type LiveDecision } from "./live-activity";

/**
 * The bottom-right live feed: what the agent is deciding, as it decides
 * it, on every dashboard page.
 *
 * The product's whole claim is that it is doing bounded work on the
 * merchant's behalf continuously, not only when someone clicks. Until
 * now that was only visible by sitting on /dashboard and watching the
 * audit trail. This surfaces it everywhere.
 *
 * Every card here is one real audit_log row arriving over the Layer
 * 15-3 stream. There is no demo mode, no synthetic event, and nothing
 * renders when the agent is genuinely idle — a quiet feed means a quiet
 * system, which is the honest thing for it to say.
 */

const TOAST_TTL_MS = 9000;
const MAX_VISIBLE = 3;
const HIDDEN_STORAGE_KEY = "activity-feed-hidden";

const TONE = {
  allow: {
    Icon: ShieldCheck,
    color: "var(--allow-bright)",
    line: "var(--allow-line)",
    wash: "var(--allow-wash)",
    verb: "Allowed",
  },
  deny: {
    Icon: ShieldX,
    color: "var(--deny-bright)",
    line: "var(--deny-line)",
    wash: "var(--deny-wash)",
    verb: "Refused",
  },
  escalate: {
    Icon: ShieldAlert,
    color: "var(--escalate-bright)",
    line: "var(--escalate-line)",
    wash: "var(--escalate-wash)",
    verb: "Escalated",
  },
} as const;

function toneFor(decision: string) {
  return TONE[decision as keyof typeof TONE] ?? {
    Icon: Activity,
    color: "var(--on-ink-dim)",
    line: "var(--ink-line)",
    wash: "transparent",
    verb: "Logged",
  };
}

/** "purchase_attempt" reads as machinery; "Purchase attempt" reads as English. */
function humanEvent(event: string): string {
  const s = event.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ActivityFeed() {
  const { recent, status, dismiss } = useLiveActivity();
  const [expanded, setExpanded] = useState(false);
  const [expired, setExpired] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // A merchant-chosen preference, not app state — read once via a lazy
  // initializer (same pattern chat-widget.tsx's sessionToken uses) so
  // it's persisted across navigation/reload without a setState-in-effect,
  // and hiding the feed actually stays hidden rather than reappearing on
  // the next page.
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDDEN_STORAGE_KEY) === "1";
    } catch {
      // localStorage unavailable — default to shown.
      return false;
    }
  });

  function setHiddenPersisted(next: boolean) {
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Best-effort — the toggle still works for this page load either way.
    }
  }

  // Each arrival gets its own dismissal timer. While the feed is
  // expanded nothing auto-expires — a merchant reading the list should
  // not have rows vanish from under them.
  useEffect(() => {
    for (const entry of recent) {
      if (timers.current.has(entry.id) || expired.has(entry.id)) continue;
      const t = setTimeout(() => {
        setExpired((prev) => new Set(prev).add(entry.id));
        timers.current.delete(entry.id);
      }, TOAST_TTL_MS);
      timers.current.set(entry.id, t);
    }
  }, [recent, expired]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const live = recent.filter((e) => !expired.has(e.id));
  const shown = expanded ? recent.slice(0, 12) : live.slice(0, MAX_VISIBLE);
  const hasAnyActivity = recent.length > 0;

  // Nothing has happened yet and nothing is wrong — say nothing, and
  // don't offer a hide toggle for a feed with nothing in it. An
  // always-present empty widget is chrome pretending to be activity.
  if (!hasAnyActivity && status !== "offline") return null;

  return (
    <div
      className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2 pointer-events-none max-w-[min(23rem,calc(100vw-2.5rem))]"
      role="log"
      aria-live="polite"
      aria-label="Live agent activity"
    >
      {!hidden && expanded && recent.length > MAX_VISIBLE && (
        <div className="pointer-events-auto text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium px-1">
          Last {shown.length} decisions
        </div>
      )}

      {!hidden &&
        shown.map((entry, i) => (
          <ActivityCard
            key={entry.id}
            entry={entry}
            index={i}
            onDismiss={() => {
              const t = timers.current.get(entry.id);
              if (t) clearTimeout(t);
              timers.current.delete(entry.id);
              dismiss(entry.id);
            }}
          />
        ))}

      {!hidden && recent.length > MAX_VISIBLE && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-ink-line bg-ink-raised/90 backdrop-blur-md px-3 py-1.5 text-xs text-on-ink-dim hover:text-on-ink transition-colors duration-[var(--dur-fast)] shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
        >
          <ChevronDown
            size={13}
            className="transition-transform duration-[var(--dur)]"
            style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          />
          {expanded ? "Collapse" : `Show ${Math.min(recent.length, 12)} recent`}
        </button>
      )}

      {/* A persistent show/hide toggle, distinct from an individual
          card's dismiss — dismissing a card clears one entry, this hides
          the whole feed and remembers the choice across pages/reloads. */}
      <button
        type="button"
        onClick={() => setHiddenPersisted(!hidden)}
        aria-pressed={!hidden}
        aria-label={hidden ? "Show live activity feed" : "Hide live activity feed"}
        title={hidden ? "Show live activity feed" : "Hide live activity feed"}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-ink-line bg-ink-raised/90 backdrop-blur-md px-3 py-1.5 text-xs text-on-ink-dim hover:text-on-ink transition-colors duration-[var(--dur-fast)] shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
      >
        <Radio size={13} style={hidden ? undefined : { color: "var(--allow-bright)" }} />
        {hidden ? "Show feed" : "Hide feed"}
      </button>
    </div>
  );
}

function ActivityCard({
  entry,
  index,
  onDismiss,
}: {
  entry: LiveDecision;
  index: number;
  onDismiss: () => void;
}) {
  const tone = toneFor(entry.decision);
  const { Icon } = tone;

  return (
    <div
      className="activity-card pointer-events-auto w-full rounded-[var(--radius-lg)] border bg-ink-raised/95 backdrop-blur-xl shadow-[0_10px_40px_rgba(0,0,0,0.6)] overflow-hidden"
      style={{
        borderColor: tone.line,
        // Stagger so a burst of decisions cascades in rather than
        // appearing as one block.
        animationDelay: `${index * 55}ms`,
      }}
    >
      <div className="relative flex gap-3 p-3.5">
        {/* The decision's colour as a real edge, matching the triad the
            rest of the dashboard reads by. */}
        <span aria-hidden="true" className="absolute left-0 inset-y-0 w-[3px]" style={{ background: tone.color }} />

        <span
          className="mt-0.5 shrink-0 flex items-center justify-center h-7 w-7 rounded-full"
          style={{ background: tone.wash }}
          aria-hidden="true"
        >
          <Icon size={15} style={{ color: tone.color }} strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold tracking-tight" style={{ color: tone.color }}>
              {tone.verb}
            </span>
            {entry.moneyAction && (
              <span className="font-mono text-sm text-on-ink tabular-nums">
                {formatPaise(entry.moneyAction.amountPaise)}
              </span>
            )}
            <span className="text-[var(--t-label)] text-on-ink-faint truncate">{humanEvent(entry.event)}</span>
          </div>

          <p className="mt-1 text-xs text-on-ink-dim leading-relaxed line-clamp-2">{entry.reason}</p>

          {entry.boundApplied && (
            <p className="mt-1.5 font-mono text-[11px] text-on-ink-faint truncate" title={entry.boundApplied}>
              {entry.boundApplied}
            </p>
          )}

          <Link
            href="/dashboard/explain"
            className="mt-2 inline-block text-[11px] text-accent hover:text-accent-bright underline underline-offset-2"
          >
            See the full decision
          </Link>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 self-start text-on-ink-faint hover:text-on-ink transition-colors duration-[var(--dur-fast)]"
        >
          <X size={13} />
        </button>
      </div>

      {/* A real countdown of this card's own dismissal timer — it is
          driven by the same duration the timeout uses, not a decorative
          loop that keeps running after the card is gone. */}
      <span aria-hidden="true" className="activity-card-timer block h-[2px]" style={{ background: tone.color }} />
    </div>
  );
}
