"use client";

import { useState } from "react";
import { useGsapContext } from "./use-gsap";

/**
 * The scroll-pinned centrepiece that replaces the old four-card grid.
 *
 * A single purchase request is scrubbed through the gate's real bound
 * order, one check at a time, tied to scroll position rather than a timer —
 * so the visitor is doing the moving and the sequence can be read at
 * whatever pace they want, forwards or backwards. The bound order and the
 * denial copy are the real ones from the gate contract, not invented
 * dressing: capability, guardian, mandate, credentials, cap, stock, price.
 *
 * The last step deliberately DENIES. The product's thesis is that a refusal
 * is the feature, so the sequence a first-time visitor watches end to end
 * should land on one, with the amount arithmetic shown as arithmetic.
 */

interface Step {
  id: string;
  label: string;
  detail: string;
  verdict: "pass" | "deny";
}

const STEPS: Step[] = [
  { id: "capability", label: "purchase:create", detail: "Granted to this key. Refunds and payouts are not in the enum at all.", verdict: "pass" },
  { id: "guardian", label: "guardian state", detail: "normal — 4 buys/hr against a 14-day p95 of 11.", verdict: "pass" },
  { id: "mandate", label: "AP2 mandate", detail: "ES256 signature verified, cart hash matches, not yet redeemed.", verdict: "pass" },
  { id: "credentials", label: "razorpay connected", detail: "Merchant keys resolved and decrypted for this tenant.", verdict: "pass" },
  { id: "stock", label: "stock available", detail: "3 of 12 reserved atomically in the same UPDATE.", verdict: "pass" },
  { id: "price", label: "catalogue price match", detail: "₹1,400.00 asserted, ₹1,400.00 on file. Exact, in paise.", verdict: "pass" },
  { id: "cap", label: "spend cap balance", detail: "₹4,200.00 requested against ₹1,180.00 remaining.", verdict: "deny" },
];

export function GateSequence() {
  const [active, setActive] = useState(0);

  const ref = useGsapContext(({ gsap, reduced }) => {
    if (reduced) {
      gsap.set("[data-track]", { autoAlpha: 1 });
      setActive(STEPS.length - 1);
      return;
    }

    // The pin lasts one viewport per step, so each check gets a full,
    // unhurried scroll beat rather than all seven flying past in one.
    ScrollTriggerSequence(gsap, setActive);
  }, []);

  const current = STEPS[active];
  const denied = current.verdict === "deny";

  return (
    <section
      ref={ref}
      id="surfaces"
      className="relative"
    >
      <div data-pin className="relative min-h-screen flex items-center overflow-hidden px-6 md:px-10">
        {/* Grid floor, the one piece of pure atmosphere here. Masked to
            fade out before it reaches the copy so it never competes. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(var(--ink-line) 1px, transparent 1px), linear-gradient(90deg, var(--ink-line) 1px, transparent 1px)",
            backgroundSize: "72px 72px",
            maskImage: "radial-gradient(ellipse 90% 60% at 50% 55%, #000 20%, transparent 78%)",
            WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 55%, #000 20%, transparent 78%)",
          }}
        />

        <div className="relative z-[2] w-full max-w-[1280px] mx-auto grid grid-cols-1 lg:grid-cols-[0.85fr_1.15fr] gap-14 lg:gap-20 items-center">
          <div className="flex flex-col gap-6">
            <p className="font-mono text-[11.5px] tracking-[0.2em] uppercase text-on-ink-faint">
              One request, every bound
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.4vw,4rem)] leading-[0.96] tracking-[-0.03em] uppercase">
              Seven checks.
              <br />
              <span className="text-accent">In order.</span>
            </h2>
            <p className="max-w-[46ch] text-[16.5px] leading-[1.6] text-on-ink-dim text-pretty">
              Every purchase — from a chat widget, an MCP tool call, or the recovery pipeline — walks the same list before a rupee is reserved. Scroll to step through it.
            </p>

            <div className="mt-2 font-mono text-[12px] tracking-[0.14em] text-on-ink-faint">
              <span className="text-on-ink tabular-nums">{String(active + 1).padStart(2, "0")}</span>
              <span className="mx-1.5">/</span>
              <span className="tabular-nums">{String(STEPS.length).padStart(2, "0")}</span>
            </div>
          </div>

          <div data-track className="relative">
            <ol className="flex flex-col">
              {STEPS.map((step, i) => {
                const state = i < active ? "done" : i === active ? "current" : "idle";
                const isDenyStep = step.verdict === "deny";
                return (
                  <li
                    key={step.id}
                    data-step={state}
                    className={[
                      "grid grid-cols-[auto_1fr] gap-x-5 items-start border-l-2 pl-6 py-4 transition-all duration-500 ease-out",
                      state === "idle" ? "opacity-25 border-ink-line" : "opacity-100",
                      state === "current" && isDenyStep ? "border-deny" : "",
                      state === "current" && !isDenyStep ? "border-accent" : "",
                      state === "done" ? "border-allow/45" : "",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "mt-[3px] inline-flex items-center justify-center h-[22px] min-w-[22px] px-1.5 rounded-[5px] font-mono text-[10.5px] tracking-[0.08em] transition-colors duration-500",
                        state === "done" ? "bg-allow-wash text-allow" : "",
                        state === "current" && isDenyStep ? "bg-deny-wash text-deny" : "",
                        state === "current" && !isDenyStep ? "bg-accent-wash text-accent-bright" : "",
                        state === "idle" ? "bg-on-ink/[0.06] text-on-ink-faint" : "",
                      ].join(" ")}
                    >
                      {state === "done" ? "OK" : state === "current" ? (isDenyStep ? "NO" : "··") : String(i + 1).padStart(2, "0")}
                    </span>

                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[14.5px] tracking-[-0.01em] text-on-ink">
                        {step.label}
                      </span>
                      <span
                        className={[
                          "text-[14px] leading-[1.5] text-on-ink-dim overflow-hidden transition-all duration-500 ease-out",
                          state === "current" ? "max-h-20 opacity-100" : "max-h-0 opacity-0",
                        ].join(" ")}
                      >
                        {step.detail}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div
              className={[
                "mt-8 flex items-center gap-3.5 px-5 py-4 rounded-xl border font-mono text-[13px] transition-all duration-500",
                denied
                  ? "border-deny-line bg-deny-wash text-on-ink opacity-100 translate-y-0"
                  : "border-ink-line bg-ink-raised text-on-ink-faint opacity-60 translate-y-1",
              ].join(" ")}
            >
              <span
                className={[
                  "inline-flex items-center h-[22px] px-[9px] rounded-[5px] text-[11px] tracking-[0.08em] shrink-0",
                  denied ? "bg-deny text-white" : "bg-on-ink/[0.08] text-on-ink-faint",
                ].join(" ")}
              >
                {denied ? "DENY" : "····"}
              </span>
              <span className="text-pretty">
                {denied
                  ? "₹4,200.00 exceeds the remaining cap of ₹1,180.00. Nothing reserved. Written to the audit log with the bound that applied."
                  : "Evaluating — no budget reserved until every check above has passed."}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Split out so the component body stays readable. Pins the stage for
 * STEPS.length viewports and maps scroll progress onto the active index —
 * floored, so a step is either reached or not, never rendered half-lit.
 */
function ScrollTriggerSequence(
  g: typeof import("gsap").default,
  setActive: (i: number) => void,
) {
  const total = STEPS.length;

  g.set("[data-track]", { autoAlpha: 1 });

  g.timeline({
    scrollTrigger: {
      trigger: "[data-pin]",
      start: "top top",
      end: () => `+=${total * 62}%`,
      pin: true,
      // A short scrub keeps the pin from feeling stuck to the pixel while
      // still letting a step land cleanly rather than flickering between two.
      scrub: 0.6,
      onUpdate: (self) => {
        // progress hits exactly 1 at the end, which would index past the
        // array — clamped rather than relying on a fudge multiplier.
        const i = Math.min(total - 1, Math.floor(self.progress * total));
        setActive(i);
      },
    },
  });
}
