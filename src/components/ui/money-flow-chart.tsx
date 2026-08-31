"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatPaise } from "@/lib/money";
import { hasEnoughMoneyToChart, type MoneyPoint } from "@/lib/chart-series";
import { ChartFrame, ChartTooltip, AXIS_STYLE, GRID_STROKE } from "./chart-frame";

/**
 * Cumulative money moved and money recovered over the window.
 *
 * Cumulative rather than per-day on purpose: it is monotonic, so the
 * curve can never imply a downturn that did not happen, and its final
 * value is a figure the merchant can check against the "Money moved"
 * headline stat directly above it. A per-day series of a handful of
 * transactions is spiky noise that reads as volatility.
 *
 * Every value in `moved`/`recovered` is integer paise. The only place
 * paise becomes rupees is formatPaise() at the tick and tooltip — there
 * is deliberately no arithmetic on money anywhere in this file.
 */
export function MoneyFlowChart({
  moved,
  recovered,
  windowDays,
  transactionCount,
}: {
  moved: MoneyPoint[];
  recovered: MoneyPoint[];
  windowDays: number;
  /** Real captures plus real recoveries in the window, counted before bucketing — see hasEnoughMoneyToChart. */
  transactionCount: number;
}) {
  const [visible, setVisible] = useState({ moved: true, recovered: true });

  // Merge on date so both series share one x-axis. Recovered can be
  // shorter (or absent) without shifting the moved curve.
  const recoveredByDate = new Map(recovered.map((p) => [p.date, p.cumulativePaise]));
  const data = moved.map((p) => ({
    date: p.date,
    movedPaise: p.cumulativePaise,
    recoveredPaise: recoveredByDate.get(p.date) ?? 0,
    dailyPaise: p.dailyPaise,
  }));

  // Gated on real transaction count, not distinct days: a cumulative
  // money curve already says something true once there are a handful of
  // genuinely separate captures, even if they land on the same day.
  const enough = hasEnoughMoneyToChart(transactionCount);

  const series = [
    { key: "movedPaise" as const, id: "moved" as const, label: "Money moved", color: "var(--accent)" },
    { key: "recoveredPaise" as const, id: "recovered" as const, label: "Money recovered", color: "var(--allow)" },
  ];

  return (
    <ChartFrame
      title="Money over time"
      description={`Cumulative captured and recovered payments across the last ${windowDays} days. Both lines only ever rise — they are running totals, not daily volume.`}
      enough={enough}
      emptyDescription="A running total needs a few real captures or recoveries before its shape means anything. This chart appears once there are."
      meta={
        <div className="flex items-center gap-1">
          {series.map((s) => {
            const on = visible[s.id];
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setVisible((v) => ({ ...v, [s.id]: !v[s.id] }))}
                aria-pressed={on}
                className={`group inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs transition-colors duration-[var(--dur-fast)] ${
                  on
                    ? "border-ink-line bg-ink-overlay text-on-ink"
                    : "border-transparent text-on-ink-faint hover:text-on-ink-dim"
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full transition-opacity duration-[var(--dur-fast)]"
                  style={{ background: s.color, opacity: on ? 1 : 0.3 }}
                />
                {s.label}
              </button>
            );
          })}
        </div>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.id} id={`fill-${s.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="0" vertical={false} />

          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
            minTickGap={28}
            tickFormatter={(d: string) =>
              new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                timeZone: "UTC",
              })
            }
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
            width={72}
            // The single conversion point from integer paise to rupees.
            tickFormatter={(paise: number) => formatPaise(paise)}
          />

          <Tooltip
            cursor={{ stroke: "var(--on-ink-faint)", strokeWidth: 1, strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as (typeof data)[number];
              return (
                <ChartTooltip
                  label={new Date(`${label}T00:00:00Z`).toLocaleDateString("en-IN", {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  })}
                  rows={[
                    ...series
                      .filter((s) => visible[s.id])
                      .map((s) => ({
                        key: s.id,
                        label: s.label,
                        value: formatPaise(point[s.key]),
                        color: s.color,
                      })),
                    ...(point.dailyPaise > 0
                      ? [
                          {
                            key: "daily",
                            label: "That day",
                            value: formatPaise(point.dailyPaise),
                            color: "var(--on-ink-faint)",
                          },
                        ]
                      : []),
                  ]}
                />
              );
            }}
          />

          {series.map((s) =>
            visible[s.id] ? (
              <Area
                key={s.id}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#fill-${s.id})`}
                // monotone, not natural: a natural spline overshoots between
                // points, which on a cumulative money curve would draw a dip
                // that never happened.
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--ink)" }}
                isAnimationActive
                animationDuration={700}
                animationEasing="ease-out"
              />
            ) : null,
          )}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
