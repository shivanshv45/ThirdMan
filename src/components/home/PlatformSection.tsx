"use client";

import Link from "next/link";
import { useGsapContext } from "./use-gsap";

/**
 * Layers 13-27 shipped an autonomous buyer agent, a returns desk, real
 * store onboarding, and a control layer none of the earlier sections on
 * this page ever mention — SurfaceMarquee above still only names the
 * four surfaces from around Layer 8. Rather than restructure that
 * section's tested scroll-velocity rails, this adds a second grid
 * covering everything after it, in the same card vocabulary
 * (data-surface-card, mono kicker, reveal-on-scroll) so it reads as a
 * continuation rather than a different design.
 */

const CARDS = [
  {
    kind: "AUTONOMOUS BUYER",
    title: "Gemini and Google ADK, actually adversarial",
    body: "A standalone Google ADK agent on Gemini 3.5 Flash, holding nothing but a real key, buying against this product the same way a stranger's agent would. No shared code with the gate it's trying to get past.",
  },
  {
    kind: "RETURNS DESK",
    title: "The model recommends. It never approves.",
    body: "An AI runs the whole return conversation and checks it against the merchant's own policy. The refund still needs a human, every single time — proven by a test the model can't get around.",
  },
  {
    kind: "STORE ONBOARDING",
    title: "A CLI, a Shopify app, a plugin, an audit page",
    body: "One shared readiness engine, five front doors: an npx CLI, a public no-install audit, a VS Code extension, a real Shopify sync, and a generated WooCommerce plugin.",
  },
  {
    kind: "CONTROL LAYER",
    title: "Guardian, a kill switch, a trust score that can't cheat",
    body: "Anomalous agents get throttled automatically. One button freezes every agent at once. A trust score can inform a merchant — it is never imported by the gate.",
  },
] as const;

const BADGES = [
  "GEMINI 3.5 FLASH",
  "GOOGLE ADK",
  "GOOGLE CLOUD SCHEDULER",
  "AP2 MANDATES",
  "X402",
  "MCP",
] as const;

export function PlatformSection({ signedIn = false }: { signedIn?: boolean }) {
  const ctaHref = signedIn ? "/dashboard" : "/signup";

  const ref = useGsapContext(({ gsap, reduced }) => {
    const cards = gsap.utils.toArray<HTMLElement>("[data-surface-card]");
    const badges = gsap.utils.toArray<HTMLElement>("[data-badge]");

    if (reduced) {
      gsap.set([...cards, ...badges], { autoAlpha: 1, y: 0 });
      return;
    }

    gsap.set(cards, { autoAlpha: 0, y: 40 });
    cards.forEach((card, i) => {
      gsap.to(card, {
        autoAlpha: 1,
        y: 0,
        duration: 0.8,
        ease: "power3.out",
        delay: (i % 2) * 0.08,
        scrollTrigger: { trigger: card, start: "top 88%", once: true },
      });
    });

    gsap.set(badges, { autoAlpha: 0, y: 14 });
    gsap.to(badges, {
      autoAlpha: 1,
      y: 0,
      duration: 0.5,
      stagger: 0.05,
      ease: "power3.out",
      scrollTrigger: { trigger: "[data-badge-row]", start: "top 90%", once: true },
    });
  }, []);

  return (
    <section ref={ref} className="relative px-6 md:px-10 py-[110px] md:py-[130px]">
      <div className="max-w-[1180px] mx-auto flex flex-col gap-14">
        <div className="flex flex-col gap-[18px] text-center max-w-[680px] mx-auto">
          <p className="font-mono text-[11.5px] tracking-[0.2em] uppercase text-on-ink-faint">
            Twenty-seven layers, not four
          </p>
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.4vw,4.15rem)] leading-[0.96] tracking-[-0.03em] uppercase">
            Past the gate,
            <br />
            <span className="text-accent">there is a lot more.</span>
          </h2>
          <p className="max-w-[52ch] mx-auto text-[16px] leading-[1.6] text-on-ink-dim text-pretty">
            An adversarial agent, a supervised returns desk, five ways onto a merchant&apos;s own store, and a control layer for the merchant who wants to watch before they trust it.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-ink-line border border-ink-line rounded-2xl overflow-hidden">
          {CARDS.map((c) => (
            <Link
              key={c.kind}
              href={ctaHref}
              data-surface-card
              className="group bg-ink-raised p-7 md:p-8 flex flex-col gap-3 min-h-[210px] transition-colors duration-300 hover:bg-ink-overlay"
            >
              <span className="font-mono text-[10.5px] tracking-[0.18em] text-accent-bright">
                {c.kind}
              </span>
              <h3 className="text-[21px] leading-[1.15] font-semibold tracking-[-0.02em]">
                {c.title}
              </h3>
              <p className="text-[14.5px] leading-[1.6] text-on-ink-dim text-pretty">
                {c.body}
              </p>
              <span
                aria-hidden="true"
                className="mt-auto self-end text-lg text-on-ink-faint transition-all duration-300 group-hover:text-on-ink group-hover:translate-x-1.5"
              >
                &rarr;
              </span>
            </Link>
          ))}
        </div>

        <div data-badge-row className="flex flex-wrap items-center justify-center gap-3">
          {BADGES.map((b) => (
            <span
              key={b}
              data-badge
              className="inline-flex items-center h-9 px-4 rounded-full border border-ink-line bg-ink-raised/60 font-mono text-[11px] tracking-[0.12em] text-on-ink-dim"
            >
              {b}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
