import { disableShadowModeAction } from "./actions";
import { Button } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Layer 24-8: rendered on every route under /dashboard whenever Shadow
 * Mode is on — the plan's own "every surface must say clearly that this
 * is shadow output" requirement, applied the same way Kill Switch
 * already earned an unmissable banner (Layer 25-2). Distinct color
 * (escalate, not deny) since Shadow Mode is not an incident — it is a
 * deliberate, ongoing choice a merchant is trying out.
 */
export function ShadowModeBanner({ enabledAt }: { enabledAt: Date }) {
  return (
    <div className="w-full bg-escalate-wash border-b border-escalate/40 px-4 md:px-8 py-2.5 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 min-w-0 text-sm">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-escalate shrink-0 animate-pulse" />
        <span className="font-medium text-escalate-bright shrink-0">Shadow Mode active</span>
        <span className="text-on-ink-dim truncate">
          — every money action is evaluated but nothing executes. Everything you see is what would have happened. (on since {formatDate(enabledAt)})
        </span>
      </div>
      <form action={disableShadowModeAction} className="shrink-0">
        <Button type="submit" variant="secondary" size="sm" pendingLabel="Turning off…">
          Turn off Shadow Mode
        </Button>
      </form>
    </div>
  );
}
