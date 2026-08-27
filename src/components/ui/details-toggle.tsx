import type { ReactNode } from "react";

/**
 * The "Show details" pattern the audit trail, explain, recovery, and
 * negotiations pages each implemented separately before this. A plain
 * <details>/<summary> works without JS and animates via CSS — no
 * client component needed for this alone.
 */
export function DetailsToggle({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs text-on-ink-faint hover:text-on-ink-dim transition-colors inline-flex items-center gap-1">
        <span className="inline-block transition-transform duration-[var(--dur-fast)] group-open:rotate-90">
          &#9656;
        </span>
        {summary}
      </summary>
      <div className="mt-2 text-xs text-on-ink-dim font-mono">{children}</div>
    </details>
  );
}
