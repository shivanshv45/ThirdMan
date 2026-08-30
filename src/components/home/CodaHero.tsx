"use client";

import Link from "next/link";
import { AntCanvas } from "./AntCanvas";

/**
 * Centered hero, ant animation running across the full section as an
 * ambient background layer behind the copy — not confined to a side card.
 * The animation stays low-key enough to sit behind text (small subject,
 * calm palette, generous negative space in its wander path) so it reads as
 * atmosphere rather than competing with the headline for attention.
 */

export function CodaHero({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <div className="relative font-[family-name:var(--font-body)]">
      <nav className="w-full flex items-center justify-between px-6 py-5 md:px-10">
        <div className="relative flex items-center group cursor-pointer select-none">
          <span className="text-[24px] font-black tracking-tight text-on-ink drop-shadow-sm transition-colors duration-500 group-hover:text-white">
            Third
          </span>
          <span className="text-[24px] font-black tracking-tight text-accent drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.5)]">
            Man
          </span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-[14.5px] font-medium text-on-ink">
          <Link href="#surfaces" className="hover:opacity-65 transition-opacity">Products</Link>
          <Link href="#refusal" className="hover:opacity-65 transition-opacity">The refusal</Link>
          <Link href="#proof" className="hover:opacity-65 transition-opacity">Proof</Link>
        </div>
        <div className="flex items-center gap-4">
          {signedIn ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center h-[42px] px-[22px] rounded-none bg-black text-[14.5px] font-medium transition-colors"
              style={{ color: '#ffffff' }}
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="hidden md:block text-[14.5px] font-medium hover:opacity-65 transition-opacity">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center h-[42px] px-[22px] rounded-none bg-black text-[14.5px] font-medium transition-colors"
                style={{ color: '#ffffff' }}
              >
                Get a scoped key
              </Link>
            </>
          )}
        </div>
      </nav>

      <section className="relative px-6 md:px-10 pt-6 pb-20 lg:pb-24 min-h-[640px] lg:min-h-[720px] flex items-center justify-center overflow-hidden">
        {/* Ambient background layer: the ant's whole wander-to-carry cycle
            plays across the entire hero, behind the copy. The coin must
            never spawn under the text block, so its real bounding box is
            measured at runtime via avoidSelector rather than guessed as a
            fixed fraction of the section — the copy's height changes with
            viewport width and font load, a hardcoded rectangle would drift
            out of sync with it. */}
        <AntCanvas scale={1.6} avoidSelector="[data-hero-text]" />

        <div data-hero-text className="relative z-[2] flex flex-col items-center gap-7 max-w-[760px] text-center">
          <div className="inline-flex items-center h-10 px-5 rounded-full bg-on-ink/[0.06] font-mono text-[12.5px] tracking-[0.08em] text-on-ink">
            AGENTS ARE THE NEW BUYERS &rarr;
          </div>

          <h1 className="font-[family-name:var(--font-display)] text-[clamp(2rem,4.5vw,4.5rem)] max-w-3xl leading-[1.05] tracking-[-0.035em] uppercase text-on-ink text-balance">
            THE &ldquo;THIRD&rdquo; MAN BETWEEN YOU AND THE BUYER
          </h1>

          <p className="max-w-[44ch] text-[17px] leading-[1.55] text-on-ink-dim text-pretty">
            Let AI agents buy from you without letting them spend freely. Every money action carries a cap, a reason, and a log entry.
          </p>

          <div className="flex items-center gap-5 flex-wrap justify-center">
            <Link
              href={signedIn ? "/dashboard" : "/signup"}
              className="inline-flex items-center h-[54px] px-[30px] rounded-none bg-black text-[15px] font-semibold hover:bg-black/80 transition-colors"
              style={{ color: '#ffffff' }}
            >
              {signedIn ? "Go to dashboard" : "Create a merchant account"}
            </Link>
            <Link
              href="#surfaces"
              className="text-[15px] font-medium border-b border-on-ink/30 pb-[3px] hover:opacity-65 transition-opacity"
            >
              See how the gate works &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* Deep-green payoff — rounded top, so it reads as a distinct plate
          rising over the paper rather than a flat section break. */}
      <section
        className="relative bg-accent text-accent-ink px-6 md:px-10 py-[110px] md:py-[150px]"
        style={{ borderRadius: "50% 50% 0 0 / 70px 70px 0 0" }}
      >
        <div className="max-w-[1000px] mx-auto flex flex-col gap-8 items-center text-center">
          <div className="font-mono text-[12px] tracking-[0.2em] text-accent-ink/55">
            GROW WITH US
          </div>
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.4rem,5.6vw,5.6rem)] leading-[0.94] tracking-[-0.035em] uppercase">
            A refusal is a feature.
          </h2>
          <p className="max-w-[62ch] text-[17px] md:text-[18px] leading-[1.6] text-accent-ink/80 text-pretty">
            When an agent asks for more than it is allowed, the answer is no — in a full sentence, naming the bound that applied, written to the audit log before anything moves.
          </p>
          <div className="mt-2 inline-flex items-center gap-3.5 px-[18px] py-3 rounded-xl bg-accent-ink/[0.08] border border-accent-ink/[0.18] font-mono text-[13px]">
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-[5px] bg-deny-wash text-deny text-[11px] tracking-[0.08em]">
              DENY
            </span>
            <span className="text-accent-ink/85">
              ₹4,200.00 exceeds the remaining cap of ₹1,180.00 for agent <em className="not-italic text-accent-ink">buyer-02</em>.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
