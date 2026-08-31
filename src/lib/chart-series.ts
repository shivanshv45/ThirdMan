/**
 * Chart data shaping for the dashboard. Every function here is pure:
 * it takes rows already fetched and merchant-scoped by dashboard.ts and
 * returns points ready to render. No queries, no float, no formatting.
 *
 * Two rules this module exists to enforce, both from
 * plans/layer-9-interface-and-close.md's chart section:
 *
 * 1. Amounts stay integer paise all the way through. A chart axis is
 *    the most natural place in the codebase to write `x / 100`, which
 *    is exactly the bug CLAUDE.md rule 3 exists to prevent. Conversion
 *    happens once, at the tick formatter, via money.ts's formatPaise.
 * 2. A series is only rendered when there is genuinely enough of it to
 *    be true. L9-3 rejected time-series charting outright because "a
 *    chart that renders a dramatic curve from three points is a lie."
 *    Layer 28 reinstates charts on the condition that the gate below is
 *    the thing that decides, deterministically, whether one is honest.
 */

/** A point on a money series. Value is integer paise, never rupees. */
export interface MoneyPoint {
  /** ISO date (UTC), YYYY-MM-DD — the bucket this point covers. */
  date: string;
  /** Cumulative integer paise at the end of this bucket. */
  cumulativePaise: number;
  /** Integer paise that landed within this bucket alone. */
  dailyPaise: number;
}

/** A point on a decision series. All values are integer counts. */
export interface DecisionPoint {
  date: string;
  allow: number;
  deny: number;
  escalate: number;
  total: number;
}

/**
 * The minimum number of distinct buckets a series needs before a curve
 * drawn through it says anything true. Four is the smallest number that
 * can show a direction *and* a change in direction; below that a line
 * chart is two points and a slope, which reads as a trend the data has
 * not earned.
 *
 * This is a bound, so it is a constant in deterministic code and never
 * a model's judgment (CLAUDE.md rule 2).
 */
export const MIN_POINTS_TO_CHART = 4;

/**
 * The floor for the money chart specifically: real underlying
 * transactions rather than distinct days. A cumulative money curve
 * built from, say, 4 genuinely separate captures already says something
 * true about this merchant's money movement even if those captures
 * happened to land on the same calendar day — unlike the per-day
 * decision-activity chart, where clustering on one day really would
 * misrepresent a trend that isn't there. Kept deliberately low and
 * deliberately a real count, never a fabricated one: this changes what
 * "enough" means, not what's in the database.
 */
export const MIN_TRANSACTIONS_TO_CHART_MONEY = 3;

/**
 * The honesty gate for count-based series (decisions per day, and
 * anything else bucketed by calendar day). Every chart on the dashboard
 * that draws a per-day trend calls this and renders an explicit "not
 * enough activity yet" state when it returns false.
 *
 * Distinct *non-empty* buckets is the right measure, not array length:
 * bucketing 30 days of history around three real events produces 30
 * points, 27 of them zero, and a chart of that is a flat line with a
 * spike — visually a trend, factually three events. Counting only
 * buckets with real activity stops that.
 */
export function hasEnoughToChart(points: Array<{ total?: number; dailyPaise?: number }>): boolean {
  const nonEmpty = points.filter((p) => (p.total ?? 0) > 0 || (p.dailyPaise ?? 0) > 0);
  return nonEmpty.length >= MIN_POINTS_TO_CHART;
}

/**
 * The honesty gate for the money chart: counts real underlying rows
 * (individual captures/recoveries), not distinct days. See
 * MIN_TRANSACTIONS_TO_CHART_MONEY for why this measure differs from
 * hasEnoughToChart's day-bucket count. Takes a count directly since the
 * caller already has the real row count before any bucketing happens.
 */
export function hasEnoughMoneyToChart(transactionCount: number): boolean {
  return transactionCount >= MIN_TRANSACTIONS_TO_CHART_MONEY;
}

/** UTC day key for a timestamp. UTC because the DB stores UTC (CLAUDE.md's time convention). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every UTC day from `from` to `to` inclusive. Buckets have to be dense
 * so a gap in activity renders as a gap rather than being silently
 * closed up — a sparse series drawn as a continuous line compresses
 * quiet weeks into the same visual distance as busy ones.
 */
export function dayRange(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    days.push(dayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Buckets dated integer-paise amounts into a cumulative daily series.
 *
 * Cumulative is the honest shape for money moved: it is monotonic, so
 * the curve cannot imply a downturn that did not happen, and its final
 * value is a figure the merchant can check against the headline stat.
 * `dailyPaise` rides along for the bar/area overlay.
 */
export function toCumulativeMoneySeries(
  rows: Array<{ createdAt: Date; amountPaise: number }>,
  windowDays: number,
): MoneyPoint[] {
  if (rows.length === 0) return [];

  const to = new Date();
  const from = new Date(to.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);

  const perDay = new Map<string, number>();
  for (const row of rows) {
    if (row.createdAt < from) continue;
    const key = dayKey(row.createdAt);
    // Integer addition only. Amounts arrive as integer paise and leave as integer paise.
    perDay.set(key, (perDay.get(key) ?? 0) + row.amountPaise);
  }

  let running = 0;
  return dayRange(from, to).map((date) => {
    const dailyPaise = perDay.get(date) ?? 0;
    running += dailyPaise;
    return { date, cumulativePaise: running, dailyPaise };
  });
}

/**
 * Buckets audit rows into a daily allow/deny/escalate series — the
 * time-resolved version of the snapshot DecisionComposition already
 * renders. Counts only; there is no money arithmetic in this function.
 */
export function toDecisionSeries(
  rows: Array<{ createdAt: Date; decision: string }>,
  windowDays: number,
): DecisionPoint[] {
  if (rows.length === 0) return [];

  const to = new Date();
  const from = new Date(to.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);

  const perDay = new Map<string, { allow: number; deny: number; escalate: number }>();
  for (const row of rows) {
    if (row.createdAt < from) continue;
    const key = dayKey(row.createdAt);
    const bucket = perDay.get(key) ?? { allow: 0, deny: 0, escalate: 0 };
    if (row.decision === "allow" || row.decision === "deny" || row.decision === "escalate") {
      bucket[row.decision] += 1;
    }
    perDay.set(key, bucket);
  }

  return dayRange(from, to).map((date) => {
    const b = perDay.get(date) ?? { allow: 0, deny: 0, escalate: 0 };
    return { date, ...b, total: b.allow + b.deny + b.escalate };
  });
}

/**
 * Spend-cap utilisation per agent, as integer paise plus an integer
 * percentage. The percentage is computed here rather than in the chart
 * because it is arithmetic on money and belongs in deterministic code
 * (CLAUDE.md rule 2), and because doing it at render time is where a
 * float creeps in.
 *
 * Rounds down: showing 99% for an agent that has not actually spent its
 * whole cap is the safe direction to be wrong in.
 */
export function toCapUtilisation(
  agents: Array<{ id: string; name: string; cap: { capPaise: number; spentPaise: number; remainingPaise: number } | null }>,
): Array<{ id: string; name: string; capPaise: number; spentPaise: number; remainingPaise: number; percent: number }> {
  return agents
    .filter((a): a is typeof a & { cap: NonNullable<typeof a.cap> } => a.cap !== null)
    .map((a) => ({
      id: a.id,
      name: a.name,
      capPaise: a.cap.capPaise,
      spentPaise: a.cap.spentPaise,
      remainingPaise: a.cap.remainingPaise,
      percent: a.cap.capPaise === 0 ? 0 : Math.floor((a.cap.spentPaise * 100) / a.cap.capPaise),
    }));
}
