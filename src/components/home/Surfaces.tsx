"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

/**
 * The three surfaces the product actually ships, plus the recovery layer.
 * Matches the Claude Design reference's grid exactly: two rows, each a
 * 1.62:1 then 1:1.28 split — not four equal cards. The agent card is
 * widest because it is the product's actual thesis; card size encodes
 * real hierarchy rather than decorating an arbitrary bento.
 *
 * Wrapped in .coda-dark-band so this section renders with the product's
 * real dark tokens (identical to the dashboard) rather than the paper
 * tokens the rest of the landing page uses — see globals.css.
 */

export function Surfaces({ signedIn = false }: { signedIn?: boolean }) {
  const ctaHref = signedIn ? "/dashboard" : "/signup";
  const ref = useRef<HTMLElement>(null);

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
          const delay = Number(el.dataset.riseDelay ?? 0);
          window.setTimeout(() => el.setAttribute("data-rise", "in"), delay);
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

  return (
    <section
      ref={ref}
      id="surfaces"
      className="coda-dark-band relative px-6 md:px-10 py-[120px] md:py-[130px]"
    >
      <div className="max-w-[1280px] mx-auto flex flex-col gap-[54px]">
        <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-12 items-end" data-rise>
          <div className="flex flex-col gap-[18px]">
            <p className="font-mono text-[11.5px] tracking-[0.2em] uppercase text-on-ink-faint">
              One backend, one audit log
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.4vw,4.15rem)] leading-[0.96] tracking-[-0.03em] uppercase">
              Four surfaces.
              <br />
              <span className="text-accent">The same gate.</span>
            </h2>
          </div>
          <p className="text-[16.5px] leading-[1.6] text-on-ink-dim text-pretty">
            A human in a chat widget and an autonomous agent over MCP reach the same cap check and write to the same log. There is no separate demo path.
          </p>
        </div>

        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 lg:grid-cols-[1.62fr_1fr] gap-5">
            <Link
              href={ctaHref}
              data-rise
              className="group flex flex-col gap-4 p-[34px] min-h-[260px] rounded-[20px] bg-ink-raised border border-ink-line transition-colors duration-300 hover:border-on-ink/30"
            >
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent-bright">
                AGENT API + MCP
              </div>
              <h3 className="text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]">
                Headless, gated, no UI
              </h3>
              <p className="max-w-[60ch] text-[15.5px] leading-[1.62] text-on-ink-dim text-pretty">
                An external AI buyer calls the same endpoint a human checkout does — and hits the same cap check, the same stock check, the same audit write. One gated call per purchase decision, by design.
              </p>
              <div className="mt-auto flex gap-2 flex-wrap font-mono text-[11.5px] text-on-ink-faint">
                {["purchase", "get_spend_status", "negotiate", "check_availability"].map((tag) => (
                  <span key={tag} className="px-2.5 py-[5px] border border-ink-line rounded-md">
                    {tag}
                  </span>
                ))}
              </div>
              <span
                aria-hidden="true"
                className="self-end text-lg text-on-ink transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-2"
              >
                &rarr;
              </span>
            </Link>

            <Link
              href={ctaHref}
              data-rise
              data-rise-delay="70"
              className="group flex flex-col gap-4 p-[34px] rounded-[20px] bg-ink-raised border border-ink-line transition-colors duration-300 hover:border-on-ink/30"
            >
              <div className="font-mono text-[11px] tracking-[0.18em] text-on-ink-faint">
                MERCHANT DASHBOARD
              </div>
              <h3 className="text-2xl leading-[1.15] font-semibold tracking-[-0.02em]">
                Spend caps and the decision stream
              </h3>
              <p className="text-[15px] leading-[1.6] text-on-ink-dim text-pretty">
                Set a cap per agent. Watch every allow, deny and escalation land in one stream, each with the reason in plain language.
              </p>
              <div className="mt-auto flex h-2 rounded-full overflow-hidden">
                <span className="flex-[62] bg-allow" />
                <span className="flex-[26] bg-deny" />
                <span className="flex-[12] bg-escalate" />
              </div>
            </Link>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.28fr] gap-5">
            <Link
              href={ctaHref}
              data-rise
              data-rise-delay="140"
              className="group flex flex-col gap-4 p-[34px] rounded-[20px] bg-ink-raised border border-ink-line transition-colors duration-300 hover:border-on-ink/30"
            >
              <div className="font-mono text-[11px] tracking-[0.18em] text-on-ink-faint">
                REVENUE RECOVERY
              </div>
              <h3 className="text-2xl leading-[1.15] font-semibold tracking-[-0.02em]">
                Retries that stop themselves
              </h3>
              <p className="text-[15px] leading-[1.6] text-on-ink-dim text-pretty">
                A failed payment gets a real Razorpay Payment Link and a bounded retry schedule. The stopping rule is arithmetic, not a model call.
              </p>
              <div className="mt-auto font-mono text-xs text-escalate">
                attempt 3 of 3 — stopped by rule
              </div>
            </Link>

            <Link
              href={ctaHref}
              data-rise
              data-rise-delay="210"
              className="group flex flex-col gap-4 p-[34px] rounded-[20px] bg-ink-raised border border-ink-line transition-colors duration-300 hover:border-on-ink/30"
            >
              <div className="font-mono text-[11px] tracking-[0.18em] text-on-ink-faint">
                BUYER CHAT
              </div>
              <h3 className="text-2xl leading-[1.15] font-semibold tracking-[-0.02em]">
                A storefront that answers questions
              </h3>
              <p className="text-[15px] leading-[1.6] text-on-ink-dim text-pretty">
                Conversational discovery over your real catalogue, with a multi-line cart that checks out as one real order. Costs and floors never appear in the page source.
              </p>
              <div className="mt-auto flex gap-2.5 items-center font-mono text-xs text-on-ink-faint">
                <span className="inline-flex gap-1">
                  <span className="w-[5px] h-[5px] rounded-full bg-on-ink-faint block" />
                  <span className="w-[5px] h-[5px] rounded-full bg-on-ink-faint block" />
                  <span className="w-[5px] h-[5px] rounded-full bg-on-ink-faint block" />
                </span>
                <span>cart: 3 lines · one order</span>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
