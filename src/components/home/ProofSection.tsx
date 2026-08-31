"use client";

import { useGsapContext } from "./use-gsap";

/**
 * A single-merchant illustration of what the decision stream looks like at
 * volume — not a live cross-merchant aggregate. This is a multi-tenant
 * platform with no single "the merchant" (see CLAUDE.md); a real number
 * here would have to be one merchant's, chosen arbitrarily, which is worse
 * than being honest that this is a worked example. Same treatment as the
 * "refusal" example in CodaHero — explicitly labelled, never implied real.
 * See DECISIONS.md, "The landing hero's ... 'refusal' example is explicitly
 * labelled illustrative," which set this precedent.
 *
 * The count-up is GSAP scrubbing a real number, not a fake loading effect:
 * it runs once when the tile enters view and lands on the stated figure.
 * The label above the grid still says illustrative, because animating a
 * number does not make it more true.
 */

const STATS = [
  { label: "MONEY MOVED", value: 842190, prefix: "₹", decimals: 2, tone: "" },
  { label: "REFUSALS", value: 1204, prefix: "", decimals: 0, tone: "text-deny" },
  { label: "ARITHMETIC, NO MODEL", value: 96.4, prefix: "", suffix: "%", decimals: 1, tone: "text-accent" },
  { label: "MEDIAN GATE TIME", value: 41, prefix: "", suffix: " ms", decimals: 0, tone: "" },
] as const;

function format(n: number, decimals: number, prefix: string, suffix: string) {
  const fixed = n.toFixed(decimals);
  const [whole, frac] = fixed.split(".");
  // Indian grouping for the rupee figure, plain grouping otherwise —
  // matching how the dashboard renders money everywhere else.
  const grouped =
    prefix === "₹"
      ? whole.replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${prefix}${grouped}${frac ? `.${frac}` : ""}${suffix}`;
}

export function ProofSection() {
  const ref = useGsapContext(({ gsap, reduced }) => {
    const tiles = gsap.utils.toArray<HTMLElement>("[data-stat]");

    tiles.forEach((tile) => {
      const out = tile.querySelector<HTMLElement>("[data-value]");
      if (!out) return;

      const target = Number(tile.dataset.value);
      const decimals = Number(tile.dataset.decimals);
      const prefix = tile.dataset.prefix ?? "";
      const suffix = tile.dataset.suffix ?? "";

      if (reduced) {
        out.textContent = format(target, decimals, prefix, suffix);
        gsap.set(tile, { autoAlpha: 1, y: 0 });
        return;
      }

      const counter = { n: 0 };
      gsap.set(tile, { autoAlpha: 0, y: 26 });

      gsap
        .timeline({ scrollTrigger: { trigger: tile, start: "top 88%", once: true } })
        .to(tile, { autoAlpha: 1, y: 0, duration: 0.65, ease: "power3.out" })
        .to(
          counter,
          {
            n: target,
            duration: 1.5,
            ease: "power2.out",
            onUpdate: () => {
              out.textContent = format(counter.n, decimals, prefix, suffix);
            },
          },
          "-=0.4",
        );
    });
  }, []);

  return (
    <section ref={ref} id="proof" className="relative px-6 md:px-10 pb-[130px]">
      <div className="max-w-[1180px] mx-auto">
        <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-on-ink-dim mb-4">
          One merchant&apos;s numbers, illustrative — every merchant sees only their own
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-on-ink/[0.12] border border-on-ink/[0.12] rounded-2xl overflow-hidden">
          {STATS.map((s) => (
            <div
              key={s.label}
              data-stat
              data-value={s.value}
              data-decimals={s.decimals}
              data-prefix={s.prefix}
              data-suffix={"suffix" in s ? s.suffix : ""}
              className="bg-ink px-6 py-[30px] flex flex-col gap-2"
            >
              <span className="font-mono text-[11px] tracking-[0.16em] text-on-ink-faint">
                {s.label}
              </span>
              <span
                data-value
                className={`font-mono text-[clamp(1.5rem,3vw,1.95rem)] tabular-nums tracking-[-0.02em] ${s.tone}`}
              >
                {format(0, s.decimals, s.prefix, "suffix" in s ? s.suffix : "")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
