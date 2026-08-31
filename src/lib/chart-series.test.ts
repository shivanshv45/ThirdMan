import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  MIN_POINTS_TO_CHART,
  MIN_TRANSACTIONS_TO_CHART_MONEY,
  hasEnoughToChart,
  hasEnoughMoneyToChart,
  toCumulativeMoneySeries,
  toDecisionSeries,
  toCapUtilisation,
  dayRange,
  dayKey,
} from "./chart-series";

/** N days before now, as a real Date — the shape rows arrive in from Postgres. */
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe("hasEnoughToChart — the honesty gate", () => {
  it("refuses a series with fewer than MIN_POINTS_TO_CHART active buckets", () => {
    const threeRealEvents = [
      { total: 1 },
      { total: 0 },
      { total: 2 },
      { total: 0 },
      { total: 0 },
      { total: 1 },
    ];
    // Six points, but only three days anything actually happened.
    expect(threeRealEvents.length).toBeGreaterThan(MIN_POINTS_TO_CHART);
    expect(hasEnoughToChart(threeRealEvents)).toBe(false);
  });

  it("allows a series once MIN_POINTS_TO_CHART buckets have real activity", () => {
    const points = Array.from({ length: MIN_POINTS_TO_CHART }, () => ({ total: 1 }));
    expect(hasEnoughToChart(points)).toBe(true);
  });

  it("counts money buckets by real paise, not by array length", () => {
    const padded = [
      { dailyPaise: 0 },
      { dailyPaise: 0 },
      { dailyPaise: 5000 },
      { dailyPaise: 0 },
    ];
    expect(hasEnoughToChart(padded)).toBe(false);
  });

  it("refuses an empty series", () => {
    expect(hasEnoughToChart([])).toBe(false);
  });

  /* The gate is the thing standing between a real merchant with three
     lifetime transactions and a chart that draws a trend out of them.
     Property: no arrangement of activity below the threshold can ever
     open the gate, regardless of how many empty buckets pad it out. */
  it("cannot be opened by padding, for any bucket count", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 5 }), { minLength: 0, maxLength: 90 }), (totals) => {
        const active = totals.filter((t) => t > 0).length;
        const points = totals.map((total) => ({ total }));
        expect(hasEnoughToChart(points)).toBe(active >= MIN_POINTS_TO_CHART);
      }),
    );
  });
});

describe("hasEnoughMoneyToChart — the money chart's own gate", () => {
  it("refuses below the transaction floor", () => {
    for (let n = 0; n < MIN_TRANSACTIONS_TO_CHART_MONEY; n++) {
      expect(hasEnoughMoneyToChart(n)).toBe(false);
    }
  });

  it("allows at and above the transaction floor", () => {
    expect(hasEnoughMoneyToChart(MIN_TRANSACTIONS_TO_CHART_MONEY)).toBe(true);
    expect(hasEnoughMoneyToChart(MIN_TRANSACTIONS_TO_CHART_MONEY + 5)).toBe(true);
  });

  it("counts real transactions regardless of how many days they span — clustering on one day is not disqualifying here", () => {
    // Unlike hasEnoughToChart, this gate has no notion of days at all;
    // it only ever sees a count. Three real captures on the same
    // calendar day still clear it, because a cumulative running total
    // is honest at three real points regardless of when they landed.
    expect(hasEnoughMoneyToChart(MIN_TRANSACTIONS_TO_CHART_MONEY)).toBe(true);
  });

  it("agrees with a direct threshold comparison for any count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (n) => {
        expect(hasEnoughMoneyToChart(n)).toBe(n >= MIN_TRANSACTIONS_TO_CHART_MONEY);
      }),
    );
  });
});

describe("toCumulativeMoneySeries", () => {
  it("returns an empty series for no rows, rather than a flat line at zero", () => {
    expect(toCumulativeMoneySeries([], 30)).toEqual([]);
  });

  it("accumulates integer paise and never divides", () => {
    const rows = [
      { createdAt: daysAgo(3), amountPaise: 12345 },
      { createdAt: daysAgo(2), amountPaise: 1 },
      { createdAt: daysAgo(1), amountPaise: 99999 },
    ];
    const series = toCumulativeMoneySeries(rows, 7);
    const last = series[series.length - 1];

    expect(last.cumulativePaise).toBe(12345 + 1 + 99999);
    // Every value stays a safe integer — a float anywhere upstream shows up here.
    for (const p of series) {
      expect(Number.isInteger(p.cumulativePaise)).toBe(true);
      expect(Number.isInteger(p.dailyPaise)).toBe(true);
    }
  });

  it("is monotonic — a cumulative money curve can never turn down", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 0, max: 20 }),
            amountPaise: fc.integer({ min: 0, max: 1000000 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (raw) => {
          const rows = raw.map((r) => ({ createdAt: daysAgo(r.day), amountPaise: r.amountPaise }));
          const series = toCumulativeMoneySeries(rows, 21);
          for (let i = 1; i < series.length; i++) {
            expect(series[i].cumulativePaise).toBeGreaterThanOrEqual(series[i - 1].cumulativePaise);
          }
        },
      ),
    );
  });

  it("drops rows older than the window rather than folding them into day one", () => {
    const rows = [
      { createdAt: daysAgo(400), amountPaise: 50000 },
      { createdAt: daysAgo(1), amountPaise: 100 },
    ];
    const series = toCumulativeMoneySeries(rows, 7);
    expect(series[series.length - 1].cumulativePaise).toBe(100);
  });

  it("sums the daily buckets to exactly the final cumulative value", () => {
    const rows = [
      { createdAt: daysAgo(5), amountPaise: 7 },
      { createdAt: daysAgo(5), amountPaise: 11 },
      { createdAt: daysAgo(2), amountPaise: 13 },
    ];
    const series = toCumulativeMoneySeries(rows, 10);
    const summed = series.reduce((acc, p) => acc + p.dailyPaise, 0);
    expect(summed).toBe(series[series.length - 1].cumulativePaise);
    expect(summed).toBe(31);
  });
});

describe("toDecisionSeries", () => {
  it("returns empty for no rows", () => {
    expect(toDecisionSeries([], 30)).toEqual([]);
  });

  it("buckets each decision kind into its own count", () => {
    const rows = [
      { createdAt: daysAgo(1), decision: "allow" },
      { createdAt: daysAgo(1), decision: "deny" },
      { createdAt: daysAgo(1), decision: "allow" },
      { createdAt: daysAgo(2), decision: "escalate" },
    ];
    const series = toDecisionSeries(rows, 7);
    const totals = series.reduce(
      (acc, p) => ({
        allow: acc.allow + p.allow,
        deny: acc.deny + p.deny,
        escalate: acc.escalate + p.escalate,
      }),
      { allow: 0, deny: 0, escalate: 0 },
    );
    expect(totals).toEqual({ allow: 2, deny: 1, escalate: 1 });
  });

  it("ignores decision values outside the allow/deny/escalate triad", () => {
    const rows = [
      { createdAt: daysAgo(1), decision: "n/a" },
      { createdAt: daysAgo(1), decision: "allow" },
    ];
    const series = toDecisionSeries(rows, 7);
    const total = series.reduce((acc, p) => acc + p.total, 0);
    expect(total).toBe(1);
  });

  it("keeps total equal to the sum of its parts on every bucket", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 0, max: 10 }),
            decision: fc.constantFrom("allow", "deny", "escalate", "n/a"),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (raw) => {
          const rows = raw.map((r) => ({ createdAt: daysAgo(r.day), decision: r.decision }));
          for (const p of toDecisionSeries(rows, 14)) {
            expect(p.total).toBe(p.allow + p.deny + p.escalate);
          }
        },
      ),
    );
  });
});

describe("toCapUtilisation", () => {
  it("omits agents with no cap — an uncapped agent has no utilisation to plot", () => {
    const rows = toCapUtilisation([
      { id: "a", name: "Capless", cap: null },
      { id: "b", name: "Capped", cap: { capPaise: 100000, spentPaise: 25000, remainingPaise: 75000 } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Capped");
  });

  it("computes an integer percentage without floats", () => {
    const [row] = toCapUtilisation([
      { id: "a", name: "A", cap: { capPaise: 30000, spentPaise: 10000, remainingPaise: 20000 } },
    ]);
    // 33.33% floors to 33 — never 33.333333333333336.
    expect(row.percent).toBe(33);
    expect(Number.isInteger(row.percent)).toBe(true);
  });

  it("treats a zero cap as zero percent rather than dividing by zero", () => {
    const [row] = toCapUtilisation([
      { id: "a", name: "A", cap: { capPaise: 0, spentPaise: 0, remainingPaise: 0 } },
    ]);
    expect(row.percent).toBe(0);
    expect(Number.isFinite(row.percent)).toBe(true);
  });

  it("never reports a percentage above the real one, for any cap and spend", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000000 }),
        fc.integer({ min: 0, max: 10000000 }),
        (capPaise, spentPaise) => {
          const [row] = toCapUtilisation([
            { id: "a", name: "A", cap: { capPaise, spentPaise, remainingPaise: capPaise - spentPaise } },
          ]);
          expect(Number.isInteger(row.percent)).toBe(true);
          // Floored, so it is never optimistic about how much room is left.
          expect(row.percent).toBeLessThanOrEqual((spentPaise * 100) / capPaise);
        },
      ),
    );
  });
});

describe("dayRange / dayKey", () => {
  it("is inclusive of both ends and dense in between", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-01-05T23:00:00Z");
    expect(dayRange(from, to)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
  });

  it("keys by UTC day, not local day", () => {
    expect(dayKey(new Date("2026-03-01T23:30:00Z"))).toBe("2026-03-01");
  });

  it("crosses a month boundary correctly", () => {
    const days = dayRange(new Date("2026-02-27T00:00:00Z"), new Date("2026-03-02T00:00:00Z"));
    expect(days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });
});
