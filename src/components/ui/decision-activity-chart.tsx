"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { hasEnoughToChart, type DecisionPoint } from "@/lib/chart-series";
import { ChartFrame, ChartTooltip, AXIS_STYLE, GRID_STROKE } from "./chart-frame";

/**
 * Decisions per day, stacked in the allow/deny/escalate triad — the
 * time-resolved companion to DecisionComposition's all-time snapshot.
 *
 * Stacked bars rather than lines because these are counts of discrete
 * events on discrete days. A line between two days implies the value
 * passed through the points in between, which for "number of decisions
 * made" is meaningless. Integer counts only; no money arithmetic here.
 */
export function DecisionActivityChart({ points, windowDays }: { points: DecisionPoint[]; windowDays: number }) {
  const enough = hasEnoughToChart(points);

  const series = [
    { key: "allow" as const, label: "Allowed", color: "var(--allow)" },
    { key: "escalate" as const, label: "Escalated", color: "var(--escalate)" },
    { key: "deny" as const, label: "Denied", color: "var(--deny)" },
  ];

  const busiest = points.reduce((max, p) => (p.total > max ? p.total : max), 0);

  return (
    <ChartFrame
      title="Decisions per day"
      description={`Every allow, escalation, and refusal the gate logged over the last ${windowDays} days.`}
      enough={enough}
      meta={
        busiest > 0 ? (
          <span className="text-xs text-on-ink-faint font-mono tabular-nums">
            busiest day: {busiest}
          </span>
        ) : undefined
      }
      emptyDescription="Refusals and escalations are as much the point here as approvals — this fills in as the gate makes decisions."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap="22%">
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
            width={32}
            allowDecimals={false}
          />

          <Tooltip
            cursor={{ fill: "var(--ink-overlay)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as DecisionPoint;
              if (point.total === 0) return null;
              return (
                <ChartTooltip
                  label={new Date(`${label}T00:00:00Z`).toLocaleDateString("en-IN", {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  })}
                  rows={series
                    .filter((s) => point[s.key] > 0)
                    .map((s) => ({
                      key: s.key,
                      label: s.label,
                      value: String(point[s.key]),
                      color: s.color,
                    }))}
                />
              );
            }}
          />

          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="decisions"
              fill={s.color}
              // Only the topmost segment gets the rounded cap, so a stack
              // reads as one bar rather than three stacked pills.
              radius={i === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              isAnimationActive
              animationDuration={600}
              animationBegin={i * 90}
              animationEasing="ease-out"
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
