"use client";

import { useGsapContext } from "./use-gsap";

/**
 * "AI decides judgement, code decides limits" — the graded criterion, so
 * it gets the strongest typographic treatment on the page after the hero.
 *
 * Replaces the old tab toggle. A toggle hid half the argument behind a
 * click nobody makes; the whole point is the CONTRAST, so both columns are
 * always on screen and the divider between them wipes down on scroll. The
 * two columns also counter-parallax slightly, which is what makes the
 * split read as a split rather than as two lists that happen to be adjacent.
 */

const DETERMINISTIC = [
  "Spend caps and remaining balance",
  "Retry counts and stopping rules",
  "Escalation and ROI thresholds",
  "Whether a bound was breached",
  "Negotiation floors and concessions",
  "Every arithmetic operation on money",
];

const MODEL = [
  "Classifying an ambiguous decline reason",
  "Conversational product discovery",
  "Ranking a pre-filtered set of bundles",
  "Phrasing an already-decided counter",
  "Conducting a return conversation",
  "Explaining a decision in plain language",
];

export function SplitSection() {
  const ref = useGsapContext(({ gsap, reduced }) => {
    if (reduced) {
      gsap.set("[data-col] li, [data-headline] > *", { autoAlpha: 1, y: 0 });
      gsap.set("[data-divider]", { scaleY: 1 });
      return;
    }

    gsap.set("[data-headline] > *", { autoAlpha: 0, y: 34 });
    gsap.to("[data-headline] > *", {
      autoAlpha: 1,
      y: 0,
      duration: 0.85,
      stagger: 0.09,
      ease: "power3.out",
      scrollTrigger: { trigger: "[data-headline]", start: "top 82%", once: true },
    });

    gsap.set("[data-divider]", { scaleY: 0, transformOrigin: "top" });
    gsap.to("[data-divider]", {
      scaleY: 1,
      ease: "none",
      scrollTrigger: { trigger: "[data-split]", start: "top 72%", end: "bottom 78%", scrub: true },
    });

    gsap.utils.toArray<HTMLElement>("[data-col]").forEach((col) => {
      const items = col.querySelectorAll("li");
      gsap.set(items, { autoAlpha: 0, y: 26 });
      gsap.to(items, {
        autoAlpha: 1,
        y: 0,
        duration: 0.7,
        stagger: 0.07,
        ease: "power3.out",
        scrollTrigger: { trigger: col, start: "top 84%", once: true },
      });

      // Counter-parallax: the code column rises, the model column sinks.
      gsap.to(col, {
        y: col.dataset.col === "code" ? -34 : 34,
        ease: "none",
        scrollTrigger: { trigger: "[data-split]", start: "top bottom", end: "bottom top", scrub: true },
      });
    });
  }, []);

  return (
    <section ref={ref} id="refusal" className="relative px-6 md:px-10 py-[130px] md:py-[150px]">
      <div className="max-w-[1180px] mx-auto flex flex-col gap-[70px]">
        <div data-headline className="flex flex-col gap-[22px] max-w-[900px]">
          <p className="font-mono text-[11.5px] tracking-[0.2em] uppercase text-on-ink-faint">
            Where we chose not to use AI
          </p>
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.2rem,5.2vw,4.8rem)] leading-[0.95] tracking-[-0.035em] uppercase text-balance">
            AI decides judgement.
            <br />
            <span className="text-accent">Code decides limits.</span>
          </h2>
          <p className="max-w-[58ch] text-[16.5px] leading-[1.62] text-on-ink-dim text-pretty">
            A language model never gets asked whether a transaction fits its cap. That is subtraction, and subtraction does not hallucinate. If the gate cannot evaluate a request — model down, database unreachable, state ambiguous — it denies, and logs why.
          </p>
        </div>

        <div data-split className="relative grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-0">
          <div
            data-divider
            aria-hidden="true"
            className="hidden md:block absolute left-1/2 top-0 bottom-0 w-px bg-on-ink/20"
          />

          <div data-col="code" className="md:pr-14 flex flex-col gap-7">
            <ColHeader kicker="DETERMINISTIC CODE, ALWAYS" tone="accent" />
            <ul className="flex flex-col gap-0">
              {DETERMINISTIC.map((item, i) => (
                <li
                  key={item}
                  className="flex gap-4 items-baseline py-4 border-b border-on-ink/[0.09] last:border-0"
                >
                  <span className="font-mono text-[11px] text-accent shrink-0 tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[16.5px] leading-[1.4] font-medium text-pretty">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div data-col="model" className="md:pl-14 flex flex-col gap-7">
            <ColHeader kicker="THE MODEL, LEGITIMATELY" tone="dim" />
            <ul className="flex flex-col gap-0">
              {MODEL.map((item, i) => (
                <li
                  key={item}
                  className="flex gap-4 items-baseline py-4 border-b border-on-ink/[0.09] last:border-0"
                >
                  <span className="font-mono text-[11px] text-on-ink-faint shrink-0 tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[16.5px] leading-[1.4] text-on-ink-dim text-pretty">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function ColHeader({ kicker, tone }: { kicker: string; tone: "accent" | "dim" }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`h-[7px] w-[7px] rounded-full ${tone === "accent" ? "bg-accent" : "bg-on-ink-faint"}`}
      />
      <span
        className={`font-mono text-[11px] tracking-[0.18em] ${tone === "accent" ? "text-accent" : "text-on-ink-faint"}`}
      >
        {kicker}
      </span>
    </div>
  );
}
