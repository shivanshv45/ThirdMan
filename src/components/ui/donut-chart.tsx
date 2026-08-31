"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartFrame, ChartTooltip } from "./chart-frame";

export interface DonutSlice {
  key: string;
  label: string;
  /** Integer count or integer paise. Never divided here. */
  value: number;
  color: string;
  /** Pre-formatted display value (e.g. formatPaise output). Falls back to the raw integer. */
  display?: string;
}

/**
 * A composition donut for a split that genuinely partitions a whole —
 * treasury buckets, coins issued vs. redeemed, deterministic vs.
 * model-influenced decisions.
 *
 * Only for real partitions: if the slices don't sum to something
 * meaningful, a donut invents a relationship that isn't there. Every
 * value arrives pre-computed; this component does no money arithmetic
 * (CLAUDE.md rule 3) and formats nothing itself.
 */
export function DonutChart({
  title,
  description,
  slices,
  centreLabel,
  centreValue,
  emptyTitle,
  emptyDescription,
  height = 240,
}: {
  title: string;
  description?: string;
  slices: DonutSlice[];
  /** Small caps label in the middle of the ring. */
  centreLabel?: string;
  /** The headline figure in the middle, already formatted. */
  centreValue?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  height?: number;
}) {
  const present = slices.filter((s) => s.value > 0);
  const total = present.reduce((sum, s) => sum + s.value, 0);

  return (
    <ChartFrame
      title={title}
      description={description}
      enough={total > 0}
      height={height}
      emptyTitle={emptyTitle ?? "Nothing to show yet"}
      emptyDescription={emptyDescription}
    >
      <div className="flex items-center gap-6 h-full">
        <div className="relative shrink-0" style={{ width: height, height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={present}
                dataKey="value"
                nameKey="label"
                innerRadius="62%"
                outerRadius="92%"
                paddingAngle={present.length > 1 ? 2 : 0}
                stroke="none"
                isAnimationActive
                animationDuration={700}
                animationEasing="ease-out"
              >
                {present.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const slice = payload[0].payload as DonutSlice;
                  return (
                    <ChartTooltip
                      label={slice.label}
                      rows={[
                        {
                          key: slice.key,
                          label: "Value",
                          value: slice.display ?? String(slice.value),
                          color: slice.color,
                        },
                      ]}
                    />
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>

          {(centreValue || centreLabel) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              {centreValue && (
                <span className="font-mono text-xl font-medium text-on-ink tabular-nums">{centreValue}</span>
              )}
              {centreLabel && (
                <span className="text-[var(--t-label)] uppercase tracking-[0.06em] text-on-ink-faint mt-0.5">
                  {centreLabel}
                </span>
              )}
            </div>
          )}
        </div>

        {/* A real legend with values, not just colour chips — the numbers
            are the point, and a donut alone is hard to read precisely. */}
        <div className="flex flex-col gap-2.5 min-w-0 flex-1">
          {present.map((s) => (
            <div key={s.key} className="flex items-baseline justify-between gap-4">
              <span className="inline-flex items-center gap-2 text-sm text-on-ink-dim min-w-0">
                <span className="h-2.5 w-2.5 rounded-[3px] shrink-0" style={{ background: s.color }} />
                <span className="truncate">{s.label}</span>
              </span>
              <span className="font-mono text-sm text-on-ink tabular-nums shrink-0">
                {s.display ?? s.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}
