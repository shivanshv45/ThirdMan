"use client";

import Link from "next/link";
import { useGsapContext } from "./use-gsap";

/**
 * Two counter-scrolling columns of the real MCP tool names, with the four
 * product surfaces stated between them — the shape of the racing-site
 * reference's sponsor wall, but every token here is a real tool this
 * server actually exposes, never a decorative logo grid.
 *
 * Motion is scroll-velocity driven rather than a fixed CSS marquee: the
 * columns drift on their own, and scrolling pushes them. That makes the
 * section feel attached to the visitor's input instead of looping at them.
 */

const TOOLS_LEFT = [
  "list_products",
  "get_product",
  "search_products",
  "check_availability",
  "get_merchant_policy",
  "get_spend_status",
  "get_offers",
];

const TOOLS_RIGHT = [
  "get_reward_balance",
  "redeem_reward_coins",
  "negotiate",
  "issue_checkout_mandate",
  "purchase",
  "open_return_request",
  "get_return_status",
];

const SURFACES = [
  {
    kind: "AGENT API + MCP",
    title: "Headless, gated, no UI",
    body: "An external buyer's agent gets fourteen tools over Streamable HTTP and the same cap check a human checkout hits.",
  },
  {
    kind: "MERCHANT DASHBOARD",
    title: "Every decision, with its reason",
    body: "Caps per agent, a live SSE decision stream, the recovery pipeline, returns, and a kill switch.",
  },
  {
    kind: "BUYER CHAT",
    title: "A storefront that answers back",
    body: "Discover, build a cart, negotiate inside a merchant-set floor, redeem coins, pay. One script tag on any domain.",
  },
  {
    kind: "REVENUE RECOVERY",
    title: "Retries that stop themselves",
    body: "A failed payment gets a real Payment Link and a bounded schedule. The stopping rule is arithmetic, not a model call.",
  },
];

export function SurfaceMarquee({ signedIn = false }: { signedIn?: boolean }) {
  const ctaHref = signedIn ? "/dashboard" : "/signup";

  const ref = useGsapContext(({ gsap, reduced }) => {
    const cards = gsap.utils.toArray<HTMLElement>("[data-surface-card]");

    if (reduced) {
      gsap.set(cards, { autoAlpha: 1, y: 0 });
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

    // Both rails drift constantly; scroll velocity adds to it, so the
    // wall reacts to how hard the visitor is scrolling.
    const loops = gsap.utils.toArray<HTMLElement>("[data-rail]").map((rail) => {
      const dir = rail.dataset.rail === "up" ? -1 : 1;
      const loop = gsap.to(rail, {
        yPercent: dir * -50,
        duration: 28,
        ease: "none",
        repeat: -1,
      });
      return { loop, dir };
    });

    // One shared scroll listener for both rails rather than one each, and
    // returned so gsap.context()'s revert() actually detaches it — a
    // listener left on window would survive every remount of this page.
    let last = window.scrollY;
    let raf = 0;

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        const v = window.scrollY - last;
        last = window.scrollY;
        for (const { loop, dir } of loops) {
          const boost = gsap.utils.clamp(-6, 6, 1 + (v * dir) / 14);
          gsap.to(loop, { timeScale: boost, duration: 0.25, overwrite: true });
          gsap.to(loop, { timeScale: 1, duration: 1.1, delay: 0.25, overwrite: false });
        }
        raf = 0;
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section ref={ref} className="relative overflow-hidden px-6 md:px-10 py-[110px] md:py-[130px]">
      <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,190px)_1fr_minmax(0,190px)] gap-10 lg:gap-14 items-center">
        <Rail id="up" tools={TOOLS_LEFT} />

        <div className="flex flex-col gap-12">
          <div className="flex flex-col gap-[18px] text-center max-w-[640px] mx-auto">
            <p className="font-mono text-[11.5px] tracking-[0.2em] uppercase text-on-ink-faint">
              One backend, one audit log
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.4vw,4.15rem)] leading-[0.96] tracking-[-0.03em] uppercase">
              Four surfaces.
              <br />
              <span className="text-accent">The same gate.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-ink-line border border-ink-line rounded-2xl overflow-hidden">
            {SURFACES.map((s) => (
              <Link
                key={s.kind}
                href={ctaHref}
                data-surface-card
                className="group bg-ink-raised p-7 md:p-8 flex flex-col gap-3 min-h-[210px] transition-colors duration-300 hover:bg-ink-overlay"
              >
                <span className="font-mono text-[10.5px] tracking-[0.18em] text-accent-bright">
                  {s.kind}
                </span>
                <h3 className="text-[21px] leading-[1.15] font-semibold tracking-[-0.02em]">
                  {s.title}
                </h3>
                <p className="text-[14.5px] leading-[1.6] text-on-ink-dim text-pretty">
                  {s.body}
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
        </div>

        <Rail id="down" tools={TOOLS_RIGHT} />
      </div>
    </section>
  );
}

function Rail({ id, tools }: { id: "up" | "down"; tools: string[] }) {
  // Duplicated once so the -50% loop lands seamlessly.
  const doubled = [...tools, ...tools];
  return (
    <div
      aria-hidden="true"
      className="hidden lg:block relative h-[520px] overflow-hidden"
      style={{
        maskImage: "linear-gradient(transparent, #000 18%, #000 82%, transparent)",
        WebkitMaskImage: "linear-gradient(transparent, #000 18%, #000 82%, transparent)",
      }}
    >
      <div data-rail={id} className="flex flex-col gap-3.5 will-change-transform">
        {doubled.map((tool, i) => (
          <span
            key={`${tool}-${i}`}
            className="block px-3.5 py-2.5 rounded-lg border border-ink-line bg-ink-raised/60 font-mono text-[12px] text-on-ink-dim whitespace-nowrap"
          >
            {tool}
          </span>
        ))}
      </div>
    </div>
  );
}
