"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Where we chose not to use AI" — matches the Claude Design reference's
 * layout: title+description as an end-aligned header row, a pill toggle,
 * then a bordered 5-cell grid (hairline borders between cells, not cards).
 * The toggle is real state — it genuinely swaps which list is shown, since
 * a control that looks interactive and is not is the worst tell there is.
 */

const DETERMINISTIC = [
  "Spend caps and remaining balance",
  "Retry counts and stopping rules",
  "Escalation thresholds",
  "Whether a bound was breached",
  "Every arithmetic operation on money",
];

const MODEL = [
  "Classifying an ambiguous decline reason",
  "Conversational product discovery",
  "Drafting customer-facing copy",
  "Ranking recommendations",
  "Explaining a decision in plain language",
];

type Side = "code" | "model";

export function RefusalSection() {
  const ref = useRef<HTMLElement>(null);
  const [side, setSide] = useState<Side>("code");

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-rise]"));

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach((el) => el.setAttribute("data-rise", "in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          window.setTimeout(
            () => el.setAttribute("data-rise", "in"),
            Number(el.dataset.riseDelay ?? 0),
          );
          io.unobserve(el);
        }
      },
      { rootMargin: "-8% 0px -12% 0px" },
    );

    items.forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        el.setAttribute("data-rise", "in");
      } else {
        io.observe(el);
      }
    });

    return () => io.disconnect();
  }, []);

  const rows = side === "code" ? DETERMINISTIC : MODEL;

  return (
    <section
      ref={ref}
      id="refusal"
      className="relative px-6 md:px-10 py-[120px] md:py-[130px]"
    >
      <div className="max-w-[1180px] mx-auto flex flex-col gap-[46px]">
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-12 items-end" data-rise>
          <div className="flex flex-col gap-[18px]">
            <p className="font-mono text-[11.5px] tracking-[0.2em] uppercase text-on-ink-faint">
              Where we chose not to use AI
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(2rem,4.2vw,3.9rem)] leading-[0.98] tracking-[-0.03em] uppercase">
              AI decides judgement.
              <br />
              <span className="text-accent">Code decides limits.</span>
            </h2>
          </div>
          <p className="text-[16.5px] leading-[1.62] text-on-ink-dim text-pretty">
            A language model never gets asked whether a transaction fits its cap. That is subtraction, and subtraction does not hallucinate. If the gate cannot evaluate a request — model down, database unreachable, state ambiguous — it denies and logs why.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Decision responsibility"
          data-rise
          data-rise-delay="70"
          className="self-start inline-flex p-[5px] rounded-full bg-on-ink/[0.06]"
        >
          {(
            [
              ["code", "Deterministic code"],
              ["model", "Language model"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={side === key}
              onClick={() => setSide(key)}
              className={[
                "h-10 px-5 rounded-full text-[13.5px] font-medium transition-colors duration-200",
                side === key ? "bg-ink text-on-ink" : "text-on-ink-dim hover:text-on-ink",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          data-rise
          data-rise-delay="140"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-px bg-on-ink/[0.12] border border-on-ink/[0.12] rounded-2xl overflow-hidden"
        >
          {rows.map((item, i) => (
            <div key={item} className="bg-ink p-[26px] pb-[30px] flex flex-col gap-3.5 min-h-[156px]">
              <span className="font-mono text-[11.5px] text-on-ink-faint/70">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-base leading-[1.35] font-medium text-pretty">{item}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
