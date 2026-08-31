"use client";

import type { ReactNode } from "react";
import { EmptyState } from "./empty-state";
import { MIN_POINTS_TO_CHART } from "@/lib/chart-series";

/**
 * The shared frame every chart on the dashboard sits in, and the one
 * place the honesty gate is applied to a rendered surface.
 *
 * `enough` is computed by chart-series.ts's hasEnoughToChart() from the
 * real rows — never here, and never by a model. When it is false this
 * renders an explicit "not enough activity yet" state instead of a
 * curve, which is L9-3's rule kept intact: a chart drawn through three
 * points is a trend the data has not earned, and a merchant reading it
 * would be misled about their own business.
 */
export function ChartFrame({
  title,
  description,
  meta,
  enough,
  emptyTitle = "Not enough activity yet to chart",
  emptyDescription,
  height = 260,
  children,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
  enough: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  height?: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
        <div>
          <h3 className="text-[var(--t-h4)] font-medium tracking-tight text-on-ink">{title}</h3>
          {description && <p className="text-sm text-on-ink-dim mt-1 max-w-[52ch]">{description}</p>}
        </div>
        {meta && <div className="shrink-0">{meta}</div>}
      </div>

      {enough ? (
        <div className="mt-5 flex-1 min-h-0" style={{ height }}>
          {children}
        </div>
      ) : (
        <div className="mt-5">
          <EmptyState
            title={emptyTitle}
            description={
              emptyDescription ??
              `A line needs at least ${MIN_POINTS_TO_CHART} days with real activity before it says anything true. This chart appears once there are.`
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * The tooltip body shared by every chart — the dark floating card from
 * the reference dashboards. Kept here rather than per-chart so the
 * label/value pairing and the colour dot stay identical everywhere.
 */
export function ChartTooltip({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ key: string; label: string; value: string; color: string }>;
}) {
  return (
    <div className="rounded-[var(--radius)] border border-ink-line bg-ink-raised/95 backdrop-blur-md px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.55)]">
      <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">{label}</div>
      <div className="mt-1.5 flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-6 text-xs">
            <span className="inline-flex items-center gap-1.5 text-on-ink-dim">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: r.color }} />
              {r.label}
            </span>
            <span className="font-mono tabular-nums text-on-ink">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared axis/grid styling, so every chart reads as one instrument rather than several. */
export const AXIS_STYLE = {
  stroke: "var(--on-ink-faint)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} as const;

export const GRID_STROKE = "var(--ink-line-soft)";
