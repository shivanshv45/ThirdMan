"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { dayKey, dayRange, hasEnoughMoneyToChart } from "@/lib/chart-series";
import { ChartFrame, ChartTooltip, AXIS_STYLE, GRID_STROKE } from "./chart-frame";

/**
 * Coins issued and redeemed per day, as opposing bars around a zero
 * line — issuance up, redemption down.
 *
 * A diverging bar rather than two stacked series because these are
 * genuinely opposite directions of the same quantity: a buyer earning
 * coins and a buyer spending them are not two things to add together.
 * Counts are integer coins throughout; there is no money arithmetic in
 * this file at all.
 */
export function CoinFlowChart({
  rows,
  windowDays,
}: {
  rows: Array<{ createdAt: Date; coinsDelta: number }>;
  windowDays: number;
}) {
  // Bucket signed deltas by UTC day into their two directions. The
  // ledger stores issuance as a positive delta and redemption as a
  // negative one, so the sign is what separates them — never a
  // re-derivation from some other field.
  const perDay = new Map<string, { issued: number; redeemed: number }>();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    const bucket = perDay.get(key) ?? { issued: 0, redeemed: 0 };
    if (row.coinsDelta >= 0) bucket.issued += row.coinsDelta;
    else bucket.redeemed += row.coinsDelta; // stays negative, so it plots below the axis
    perDay.set(key, bucket);
  }

  const to = new Date();
  const from = new Date(to.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
  const data = dayRange(from, to).map((date) => {
    const b = perDay.get(date) ?? { issued: 0, redeemed: 0 };
    return { date, issued: b.issued, redeemed: b.redeemed };
  });

  return (
    <ChartFrame
      title="Coin flow"
      description={`Coins issued on captured purchases, and coins redeemed against them, over the last ${windowDays} days.`}
      enough={hasEnoughMoneyToChart(rows.length)}
      emptyTitle="Not enough coin activity yet"
      emptyDescription="Issuance and redemption appear here as real purchases earn and spend coins."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap="22%" stackOffset="sign">
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="0" vertical={false} />

          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
            minTickGap={28}
            tickFormatter={(d: string) =>
              new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })
            }
          />
          <YAxis tickLine={false} axisLine={false} tick={AXIS_STYLE} width={38} allowDecimals={false} />

          {/* The zero line is the whole point of a diverging chart — it
              has to be visible, not implied by where the bars stop. */}
          <ReferenceLine y={0} stroke="var(--ink-line)" />

          <Tooltip
            cursor={{ fill: "var(--ink-overlay)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as { issued: number; redeemed: number };
              if (point.issued === 0 && point.redeemed === 0) return null;
              return (
                <ChartTooltip
                  label={new Date(`${label}T00:00:00Z`).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "UTC" })}
                  rows={[
                    ...(point.issued > 0
                      ? [{ key: "issued", label: "Issued", value: `+${point.issued}`, color: "var(--allow)" }]
                      : []),
                    ...(point.redeemed < 0
                      ? [{ key: "redeemed", label: "Redeemed", value: String(point.redeemed), color: "var(--accent)" }]
                      : []),
                  ]}
                />
              );
            }}
          />

          <Bar dataKey="issued" fill="var(--allow)" radius={[3, 3, 0, 0]} isAnimationActive animationDuration={600} animationEasing="ease-out" />
          <Bar dataKey="redeemed" fill="var(--accent)" radius={[0, 0, 3, 3]} isAnimationActive animationDuration={600} animationBegin={90} animationEasing="ease-out" />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
