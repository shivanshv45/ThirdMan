import type { ReactNode } from "react";

/**
 * A heading, one sentence, one action. Replaces the seven-odd
 * hand-rolled "No X yet" strings across the dashboard. Never rendered
 * with a fabricated sample row to "look alive" — an empty state says
 * it is empty (fact 9, plans/layer-9-interface-and-close.md).
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-ink-line px-6 py-10 text-center">
      <p className="text-sm font-medium text-on-ink">{title}</p>
      {description && <p className="mt-1 text-sm text-on-ink-dim max-w-sm mx-auto">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
