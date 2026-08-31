import Link from "next/link";
import { NotFoundMotion } from "@/components/home/NotFoundMotion";

/**
 * The 404, written in the product's own voice: this whole codebase treats a
 * refusal as a well-formed answer that names the bound it applied, so the
 * not-found page says exactly that rather than apologising. The audit-log
 * line is real in shape (the same DENY chip and reason sentence the
 * dashboard renders) but is explicitly about this request, not a fabricated
 * money action — nothing here implies a transaction that never happened.
 */
export default function NotFound() {
  return (
    <main className="flex-1 min-h-screen flex items-center justify-center px-6 py-24 relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage:
            "linear-gradient(var(--ink-line) 1px, transparent 1px), linear-gradient(90deg, var(--ink-line) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(ellipse 70% 60% at 50% 50%, #000 10%, transparent 72%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 50%, #000 10%, transparent 72%)",
        }}
      />

      <NotFoundMotion>
        <div className="relative z-[2] w-full max-w-[560px] flex flex-col items-start gap-7">
          <span className="inline-flex items-center h-[22px] px-[9px] rounded-[5px] bg-deny-wash text-deny font-mono text-[11px] tracking-[0.1em]">
            404
          </span>

          <h1 className="font-[family-name:var(--font-display)] text-[clamp(2.6rem,7vw,4.5rem)] leading-[0.95] tracking-[-0.035em] text-on-ink">
            No route
            <br />
            <span className="text-on-ink-faint">matched.</span>
          </h1>

          <p className="text-[16px] leading-[1.6] text-on-ink-dim max-w-[42ch] text-pretty">
            This one is a refusal like any other: the request was well-formed, nothing here answers to it, and saying so plainly beats guessing where you meant to go.
          </p>

          <div className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-xl border border-ink-line bg-ink-raised font-mono text-[12.5px] text-on-ink-dim">
            <span className="inline-flex items-center h-[20px] px-2 rounded-[4px] bg-deny text-white text-[10.5px] tracking-[0.08em] shrink-0">
              DENY
            </span>
            <span className="truncate">bound applied: route_not_found</span>
          </div>

          <div className="flex items-center gap-5 flex-wrap pt-1">
            <Link
              href="/"
              className="inline-flex items-center h-[46px] px-6 rounded-full bg-accent text-accent-ink text-[14.5px] font-semibold hover:bg-accent-bright transition-colors"
            >
              Back to the start
            </Link>
            <Link
              href="/dashboard"
              className="text-[14.5px] font-medium text-on-ink-dim border-b border-on-ink/25 pb-[3px] hover:text-on-ink transition-colors"
            >
              Go to the dashboard &rarr;
            </Link>
          </div>
        </div>
      </NotFoundMotion>
    </main>
  );
}
