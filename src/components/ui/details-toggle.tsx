import type { ReactNode } from "react";

/**
 * The "Show details" pattern the audit trail, explain, recovery, and
 * negotiations pages each implemented separately before this. A plain
 * <details>/<summary> works without JS and animates via CSS — no
 * client component needed for this alone.
 */
export function DetailsToggle({
  summary,
  children,
  /**
   * "detail" (default) is the small mono read-out this was built for.
   * "plain" leaves the children unstyled, for a disclosure holding real
   * interface — a form, inputs — where forcing mono/xs would be wrong.
   */
  variant = "detail",
}: {
  summary: string;
  children: ReactNode;
  variant?: "detail" | "plain";
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs text-on-ink-faint hover:text-on-ink-dim transition-colors inline-flex items-center gap-1">
        <span className="inline-block transition-transform duration-[var(--dur-fast)] group-open:rotate-90">
          &#9656;
        </span>
        {summary}
      </summary>
      <div className={variant === "detail" ? "mt-2 text-xs text-on-ink-dim font-mono" : "mt-3"}>{children}</div>
    </details>
  );
}
