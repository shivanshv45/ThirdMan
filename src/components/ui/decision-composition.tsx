/**
 * A single honest snapshot bar — allow/deny/escalate as a share of
 * total decisions — never a time series (plans/layer-9, L9-3: this
 * merchant's real history is too thin and bursty to chart a trend
 * without lying about one). Integer counts throughout; no paise
 * arithmetic in this component at all.
 */
export function DecisionComposition({
  allow,
  deny,
  escalate,
}: {
  allow: number;
  deny: number;
  escalate: number;
}) {
  const total = allow + deny + escalate;
  if (total === 0) return null;

  const segments = [
    { key: "allow", n: allow, color: "var(--allow)", label: "Allowed" },
    { key: "deny", n: deny, color: "var(--deny)", label: "Denied" },
    { key: "escalate", n: escalate, color: "var(--escalate)", label: "Escalated" },
  ].filter((s) => s.n > 0);

  let x = 0;
  const bars = segments.map((s) => {
    const w = (s.n / total) * 100;
    const bar = { ...s, x, w };
    x += w;
    return bar;
  });

  return (
    <div>
      <svg viewBox="0 0 100 10" width="100%" height="20" preserveAspectRatio="none" role="img" aria-label="Decision composition" className="rounded-full overflow-hidden">
        {bars.map((b) => (
          <rect key={b.key} x={b.x} y={0} width={b.w} height={10} fill={b.color} />
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-on-ink-dim">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label} <span className="font-mono text-on-ink">{s.n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
