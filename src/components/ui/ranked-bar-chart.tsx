"use client";

import { ChartFrame } from "./chart-frame";

export interface RankedBar {
  key: string;
  label: string;
  /** Integer count or integer paise. Never divided here. */
  value: number;
  /** Pre-formatted display value. Falls back to the raw integer. */
  display?: string;
  color?: string;
}

/**
 * A horizontal ranked bar list — which stopping rule fired most, which
 * refusal reason recurs, which use case spends most.
 *
 * Bars are proportional to the largest value, not to a total: these are
 * rankings of independent categories, not shares of a whole (a donut
 * would be the wrong shape and would imply they partition something).
 * Sorting is done here so the ranking is always actually ranked.
 */
export function RankedBarChart({
  title,
  description,
  bars,
  defaultColor = "var(--accent)",
  emptyTitle,
  emptyDescription,
  maxBars = 8,
}: {
  title: string;
  description?: string;
  bars: RankedBar[];
  defaultColor?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  maxBars?: number;
}) {
  const sorted = [...bars].filter((b) => b.value > 0).sort((a, b) => b.value - a.value).slice(0, maxBars);
  const top = sorted.length > 0 ? sorted[0].value : 0;

  return (
    <ChartFrame
      title={title}
      description={description}
      enough={sorted.length > 0}
      height={Math.max(120, sorted.length * 44)}
      emptyTitle={emptyTitle ?? "Nothing recorded yet"}
      emptyDescription={emptyDescription}
    >
      <div className="flex flex-col justify-between h-full gap-2.5">
        {sorted.map((bar) => {
          const widthPercent = top === 0 ? 0 : Math.max(2, Math.floor((bar.value * 100) / top));
          return (
            <div key={bar.key}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs text-on-ink-dim truncate" title={bar.label}>
                  {bar.label}
                </span>
                <span className="font-mono text-xs text-on-ink tabular-nums shrink-0">
                  {bar.display ?? bar.value}
                </span>
              </div>
              <div className="h-2 rounded-full bg-ink-overlay overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                  style={{ width: `${widthPercent}%`, background: bar.color ?? defaultColor }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}
