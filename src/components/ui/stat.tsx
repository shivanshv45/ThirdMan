import type { ReactNode } from "react";
import { splitPaiseForDisplay } from "./format";

type Tone = "default" | "allow" | "deny" | "escalate" | "accent";
type StatSize = "primary" | "secondary";

const TONE_COLOR: Record<Tone, string> = {
  default: "var(--on-ink)",
  allow: "var(--allow-bright)",
  deny: "var(--deny-bright)",
  escalate: "var(--escalate-bright)",
  accent: "var(--accent-bright)",
};

/* Two real sizes, not one scaled by context. A dashboard where every
   number renders at the same weight has decided nothing about which
   number matters (ui_avoidance.md, tells 4 and 11) — "money moved" and
   "deterministic vs. model" are not peers and should not look like it. */
const SIZE_CLASS: Record<StatSize, string> = {
  primary: "text-[clamp(2rem,4.4vw,3.25rem)]",
  secondary: "text-[clamp(1.25rem,2vw,1.625rem)]",
};

/**
 * The large-number component the command view is built from. Every
 * value here is arithmetic already computed by src/lib — this
 * component only renders it. Never animate a headline number past its
 * real value ("The one rule" — a number that ticks past the truth and
 * settles back undermines exactly the trust this product claims).
 */
export function Stat({
  label,
  value,
  tone = "default",
  size = "secondary",
  caption,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  size?: StatSize;
  caption?: ReactNode;
}) {
  return (
    <div>
      <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">
        {label}
      </div>
      <div
        className={`mt-2 font-mono ${SIZE_CLASS[size]} font-medium leading-none tabular-nums`}
        style={{ color: TONE_COLOR[tone] }}
      >
        {value}
      </div>
      {caption && <div className="mt-2 text-xs text-on-ink-dim">{caption}</div>}
    </div>
  );
}

/** A Stat whose value is a real integer-paise amount, split so the decimal renders smaller. */
export function MoneyStat({
  label,
  paise,
  tone = "default",
  size = "secondary",
  caption,
}: {
  label: string;
  paise: number;
  tone?: Tone;
  size?: StatSize;
  caption?: ReactNode;
}) {
  const { whole, decimal } = splitPaiseForDisplay(paise);
  return (
    <Stat
      label={label}
      tone={tone}
      size={size}
      caption={caption}
      value={
        <span>
          {whole}
          <span className="text-[0.5em] text-on-ink-faint">.{decimal}</span>
        </span>
      }
    />
  );
}
