import type { ReactNode } from "react";
import { splitPaiseForDisplay } from "./format";

type Tone = "default" | "allow" | "deny" | "escalate" | "accent";

const TONE_COLOR: Record<Tone, string> = {
  default: "var(--on-ink)",
  allow: "var(--allow-bright)",
  deny: "var(--deny-bright)",
  escalate: "var(--escalate-bright)",
  accent: "var(--accent-bright)",
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
  caption,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  caption?: ReactNode;
}) {
  return (
    <div>
      <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">
        {label}
      </div>
      <div
        className="mt-1.5 font-mono text-[clamp(1.5rem,3.2vw,2.5rem)] font-medium leading-none tabular-nums"
        style={{ color: TONE_COLOR[tone] }}
      >
        {value}
      </div>
      {caption && <div className="mt-1.5 text-xs text-on-ink-dim">{caption}</div>}
    </div>
  );
}

/** A Stat whose value is a real integer-paise amount, split so the decimal renders smaller. */
export function MoneyStat({
  label,
  paise,
  tone = "default",
  caption,
}: {
  label: string;
  paise: number;
  tone?: Tone;
  caption?: ReactNode;
}) {
  const { whole, decimal } = splitPaiseForDisplay(paise);
  return (
    <Stat
      label={label}
      tone={tone}
      caption={caption}
      value={
        <span>
          {whole}
          <span className="text-[0.55em] text-on-ink-faint">.{decimal}</span>
        </span>
      }
    />
  );
}
