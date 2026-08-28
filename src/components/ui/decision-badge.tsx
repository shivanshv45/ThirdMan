const CONFIG = {
  allow: { label: "Allowed", fg: "var(--allow-bright)", bg: "var(--allow-wash)", line: "var(--allow-line)" },
  deny: { label: "Denied", fg: "var(--deny-bright)", bg: "var(--deny-wash)", line: "var(--deny-line)" },
  escalate: { label: "Escalated", fg: "var(--escalate-bright)", bg: "var(--escalate-wash)", line: "var(--escalate-line)" },
  "n/a": { label: "Info", fg: "var(--on-ink-dim)", bg: "var(--ink-overlay)", line: "var(--ink-line)" },
} as const;

export type Decision = keyof typeof CONFIG;

/**
 * The single visual representation of allow/deny/escalate everywhere
 * it appears (audit trail, explain, negotiations, offers, recovery).
 * Every page used to style this inline with different Tailwind
 * colours — this is the one true rendering.
 *
 * compact is for dense logs (the decision stream runs to 100 rows):
 * same colour language and same text label — never colour alone, which
 * would strand anyone who can't separate the triad by hue — just less
 * chrome, so a hundred of them read as a column rather than a hundred
 * competing pills.
 */
export function DecisionBadge({
  decision,
  label,
  compact = false,
}: {
  decision: Decision;
  label?: string;
  compact?: boolean;
}) {
  const c = CONFIG[decision];

  if (compact) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[var(--t-label)] uppercase tracking-[0.06em] font-medium"
        style={{ color: c.fg }}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: c.fg }} />
        {label ?? c.label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ color: c.fg, background: c.bg, border: `1px solid ${c.line}` }}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: c.fg }} />
      {label ?? c.label}
    </span>
  );
}
