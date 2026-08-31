"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatPaise } from "@/lib/money";
import { ChartFrame, ChartTooltip, AXIS_STYLE } from "./chart-frame";

export interface CapUtilisationRow {
  id: string;
  name: string;
  capPaise: number;
  spentPaise: number;
  remainingPaise: number;
  percent: number;
}

/**
 * How much of each agent's spend cap it has actually used.
 *
 * This is the one chart with no minimum-points gate, and deliberately:
 * it is not a time series. One agent with one cap is a complete, honest
 * picture of that agent's headroom — there is no trend being implied
 * and nothing to extrapolate. The gate exists to stop a curve drawn
 * through too few points, which a horizontal bar of a current value
 * cannot do.
 *
 * `percent` arrives already computed by chart-series.ts's
 * toCapUtilisation — a floored integer. This component performs no
 * arithmetic on money at all (CLAUDE.md rules 2 and 3).
 */
export function CapUtilisationChart({ rows }: { rows: CapUtilisationRow[] }) {
  // Tone follows headroom, using the same triad the rest of the product
  // reads by: near the cap is the state a merchant needs to notice.
  const toneFor = (percent: number) =>
    percent >= 90 ? "var(--deny)" : percent >= 70 ? "var(--escalate)" : "var(--accent)";

  const sorted = [...rows].sort((a, b) => b.percent - a.percent);
  const nearLimit = sorted.filter((r) => r.percent >= 90).length;

  return (
    <ChartFrame
      title="Spend cap headroom"
      description="How much of its cap each agent has spent in the current window. The cap is enforced by arithmetic, not by a model — an agent cannot exceed this bar."
      enough={rows.length > 0}
      height={Math.max(140, sorted.length * 46 + 40)}
      emptyTitle="No agent has a spend cap yet"
      emptyDescription="An agent with no cap can never transact. Set one on Agents & caps and its headroom appears here."
      meta={
        nearLimit > 0 ? (
          <span className="text-xs font-medium text-deny-bright px-2.5 py-1 bg-deny-wash border border-deny/20 rounded-[var(--radius-pill)]">
            {nearLimit} near limit
          </span>
        ) : undefined
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={sorted} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }} barCategoryGap="30%">
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            tick={{ ...AXIS_STYLE, fontFamily: "var(--font-body)", fontSize: 12 }}
            width={120}
          />

          <Tooltip
            cursor={{ fill: "var(--ink-overlay)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as CapUtilisationRow;
              return (
                <ChartTooltip
                  label={row.name}
                  rows={[
                    { key: "spent", label: "Spent", value: formatPaise(row.spentPaise), color: toneFor(row.percent) },
                    { key: "remaining", label: "Remaining", value: formatPaise(row.remainingPaise), color: "var(--on-ink-faint)" },
                    { key: "cap", label: "Cap", value: formatPaise(row.capPaise), color: "var(--on-ink-faint)" },
                  ]}
                />
              );
            }}
          />

          {/* One bar, not two stacked: `background` paints the full-cap track
              behind it, so the spend bar still starts at zero. Stacking a
              track bar underneath would offset the spend by the cap's width. */}
          <Bar
            dataKey="percent"
            radius={4}
            barSize={14}
            isAnimationActive
            animationDuration={700}
            animationEasing="ease-out"
            background={{ fill: "var(--ink-overlay)", radius: 4 }}
            label={{
              position: "right",
              formatter: (v: unknown) => `${v}%`,
              fill: "var(--on-ink-dim)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
          >
            {sorted.map((r) => (
              <Cell key={r.id} fill={toneFor(r.percent)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
