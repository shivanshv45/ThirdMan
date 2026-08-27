/**
 * A real gauge for the readiness score — a single weighted-checklist
 * integer, honestly represented as an arc, not a decorative dial.
 */
export function ReadinessGauge({ score }: { score: number }) {
  const tone = score >= 80 ? "var(--allow-bright)" : score >= 50 ? "var(--escalate-bright)" : "var(--deny-bright)";
  const r = 54;
  const circumference = 2 * Math.PI * r;
  const filled = (score / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="140" height="140" viewBox="0 0 140 140" className="-rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--ink-line)" strokeWidth="10" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{ transition: "stroke-dasharray var(--dur-slow) var(--ease-out)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-3xl font-medium tabular-nums" style={{ color: tone }}>
          {score}%
        </span>
        <span className="text-[var(--t-label)] text-on-ink-faint uppercase tracking-[0.06em] mt-0.5">Readiness</span>
      </div>
    </div>
  );
}
