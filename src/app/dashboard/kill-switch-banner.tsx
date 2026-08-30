import { releaseKillSwitchAction } from "./actions";
import { Button } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Layer 25-2: rendered on every route under /dashboard whenever a
 * freeze is active — "a frozen platform must be unmistakable on every
 * dashboard surface, not a subtle banner on one page" (per the plan).
 * Unfreezing is one click from right here, since a merchant who
 * panicked and froze everything must be able to reverse it just as
 * fast, from wherever they land.
 */
export function KillSwitchBanner({ reason, frozenAt }: { reason: string; frozenAt: Date }) {
  return (
    <div className="w-full bg-deny-wash border-b border-deny/40 px-4 md:px-8 py-2.5 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 min-w-0 text-sm">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-deny shrink-0 animate-pulse" />
        <span className="font-medium text-deny-bright shrink-0">Kill Switch active</span>
        <span className="text-on-ink-dim truncate">
          — every agent is suspended. {reason} (thrown {formatDate(frozenAt)})
        </span>
      </div>
      <form action={releaseKillSwitchAction} className="shrink-0">
        <Button type="submit" variant="secondary" size="sm" pendingLabel="Unfreezing…">
          Unfreeze now
        </Button>
      </form>
    </div>
  );
}
