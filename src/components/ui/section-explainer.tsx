"use client";

import { useEffect, useRef, useState } from "react";
import { Info, X, ArrowRight, ArrowDown } from "lucide-react";

export interface ExplainerStep {
  label: string;
  detail?: string;
  /** Tone follows the same allow/deny/escalate triad the rest of the product reads by. */
  tone?: "default" | "allow" | "deny" | "escalate" | "accent";
}

export interface ExplainerBranch {
  /** What decides which path is taken, e.g. "Below the floor". */
  condition: string;
  steps: ExplainerStep[];
}

const TONE_STYLE: Record<NonNullable<ExplainerStep["tone"]>, { border: string; bg: string; text: string }> = {
  default: { border: "border-ink-line", bg: "bg-ink-overlay", text: "text-on-ink" },
  allow: { border: "border-allow-line", bg: "bg-allow-wash", text: "text-allow-bright" },
  deny: { border: "border-deny-line", bg: "bg-deny-wash", text: "text-deny-bright" },
  escalate: { border: "border-escalate-line", bg: "bg-escalate-wash", text: "text-escalate-bright" },
  accent: { border: "border-accent/40", bg: "bg-accent-wash", text: "text-accent-bright" },
};

function StepNode({ step }: { step: ExplainerStep }) {
  const tone = TONE_STYLE[step.tone ?? "default"];
  return (
    <div className={`rounded-[var(--radius)] border ${tone.border} ${tone.bg} px-3 py-2 min-w-[9rem]`}>
      <div className={`text-xs font-medium ${tone.text}`}>{step.label}</div>
      {step.detail && <div className="text-[11px] text-on-ink-faint mt-0.5 leading-snug">{step.detail}</div>}
    </div>
  );
}

/**
 * A hand-authored visual flow, not a paragraph and not an AI-generated
 * summary: a merchant reading this should see the literal shape of what
 * happens in their own section, expressed as nodes and arrows. Each
 * section supplies its own real steps and branches — this component
 * only lays them out and applies the shared token system.
 */
export function SectionExplainerContent({
  steps,
  branches,
}: {
  steps: ExplainerStep[];
  branches?: ExplainerBranch[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <StepNode step={step} />
            {i < steps.length - 1 && <ArrowRight size={14} className="text-on-ink-faint shrink-0" aria-hidden="true" />}
          </div>
        ))}
      </div>

      {branches && branches.length > 0 && (
        <div className="flex items-start gap-2 mt-1">
          <ArrowDown size={14} className="text-on-ink-faint shrink-0 mt-2" aria-hidden="true" />
          <div className="flex flex-col gap-3 flex-1">
            {branches.map((branch, i) => (
              <div key={i} className="rounded-[var(--radius)] border border-ink-line-soft bg-ink-overlay/50 p-3">
                <div className="text-[11px] uppercase tracking-[0.06em] text-on-ink-faint font-medium mb-2">
                  {branch.condition}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {branch.steps.map((step, j) => (
                    <div key={j} className="flex items-center gap-2">
                      <StepNode step={step} />
                      {j < branch.steps.length - 1 && (
                        <ArrowRight size={12} className="text-on-ink-faint shrink-0" aria-hidden="true" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The floating info button every sub-section gets, bottom-right, that
 * opens the section's visual flow rather than a paragraph. Positioned
 * relative to its own section container (pass a wrapping div with
 * `className="relative"`), not the viewport, so several can exist on
 * one page without colliding.
 */
export function SectionExplainer({
  title,
  steps,
  branches,
}: {
  title: string;
  steps: ExplainerStep[];
  branches?: ExplainerBranch[];
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="absolute bottom-3 right-3 z-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`How ${title} works`}
        aria-expanded={open}
        className="flex items-center justify-center h-7 w-7 rounded-full border border-ink-line bg-ink-raised/90 backdrop-blur-md text-on-ink-faint hover:text-accent-bright hover:border-accent/40 transition-colors duration-[var(--dur-fast)] shadow-[0_2px_10px_rgba(0,0,0,0.4)]"
      >
        <Info size={14} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`How ${title} works`}
          className="absolute bottom-9 right-0 w-[min(26rem,calc(100vw-3rem))] rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised/98 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.6)] p-4"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h4 className="text-sm font-medium text-on-ink">How {title} works</h4>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="text-on-ink-faint hover:text-on-ink transition-colors duration-[var(--dur-fast)]"
            >
              <X size={14} />
            </button>
          </div>
          <SectionExplainerContent steps={steps} branches={branches} />
        </div>
      )}
    </div>
  );
}
