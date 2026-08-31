"use client";

import { ChartFrame } from "./chart-frame";

export interface FunnelStage {
  key: string;
  label: string;
  /** Integer count or integer paise — this component never divides it. */
  value: number;
  color: string;
  /** Shown under the label, e.g. a formatted rupee total. Already formatted by the caller. */
  caption?: string;
}

/**
 * A stage-by-stage funnel: each bar's width is its share of the first
 * stage, so the drop between stages is the thing you actually see.
 *
 * Hand-authored SVG-free (plain divs) rather than a Recharts funnel:
 * the shape is a handful of proportional bars, and doing it directly
 * keeps the labels, captions and drop-off annotations under real
 * control instead of fighting a chart library's label placement.
 *
 * Percentages here are integer-floored share-of-total for *width only*.
 * Every displayed number is the caller's own already-computed value —
 * this component performs no arithmetic on money (CLAUDE.md rule 3).
 */
export function FunnelChart({
  title,
  description,
  stages,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description?: string;
  stages: FunnelStage[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const top = stages.length > 0 ? stages[0].value : 0;
  const enough = top > 0;

  return (
    <ChartFrame
      title={title}
      description={description}
      enough={enough}
      height={Math.max(120, stages.length * 62)}
      emptyTitle={emptyTitle ?? "Nothing has entered this funnel yet"}
      emptyDescription={emptyDescription}
    >
      <div className="flex flex-col justify-between h-full gap-2">
        {stages.map((stage, i) => {
          // Width is share of the first stage. Integer maths only; a
          // zero top stage is already handled by the gate above.
          const widthPercent = top === 0 ? 0 : Math.max(2, Math.floor((stage.value * 100) / top));
          const dropFromPrev = i > 0 ? stages[i - 1].value - stage.value : 0;

          return (
            <div key={stage.key} className="group">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs text-on-ink-dim">{stage.label}</span>
                <span className="flex items-baseline gap-2">
                  {stage.caption && <span className="text-[11px] text-on-ink-faint">{stage.caption}</span>}
                  <span className="font-mono text-sm text-on-ink tabular-nums">{stage.value}</span>
                </span>
              </div>
              <div className="relative h-6 rounded-[var(--radius-sm)] bg-ink-overlay overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-[var(--radius-sm)] transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                  style={{ width: `${widthPercent}%`, background: stage.color }}
                />
              </div>
              {i > 0 && dropFromPrev > 0 && (
                <div className="text-[11px] text-on-ink-faint mt-0.5">
                  {dropFromPrev} did not continue
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}
