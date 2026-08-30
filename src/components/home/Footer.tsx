import Link from "next/link";

/**
 * Footer doubles as the closing CTA, matching the Claude Design reference's
 * structure: headline left, copy+buttons right, then a four-column link
 * row. Wrapped in .coda-dark-band so it renders with the product's real
 * dark tokens (same as the dashboard), continuing straight on from
 * #surfaces above it with no visible seam between the two dark sections.
 *
 * Link lists only name destinations that exist. A footer full of dead hrefs
 * to a blog and a changelog that were never written is the same
 * fabrication problem as a fake table row.
 */

export function Footer({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <footer
      id="start"
      className="coda-dark-band w-full font-[family-name:var(--font-body)] px-6 md:px-10 pt-[110px] pb-10"
    >
      <div className="max-w-[1280px] mx-auto flex flex-col gap-[76px]">
        <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-14 items-end">
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.6vw,4.4rem)] leading-[0.94] tracking-[-0.035em] uppercase">
            Give an agent
            <br />
            A budget, <span className="text-accent">not a card.</span>
          </h2>
          <div className="flex flex-col gap-[26px]">
            <p className="text-base leading-[1.62] text-on-ink-dim text-pretty">
              Connect your own Razorpay keys, set a cap, and every purchase an agent makes is checked against it before anything moves.
            </p>
            <div className="flex gap-3.5 flex-wrap">
              {signedIn ? (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center h-[50px] px-[26px] rounded-full bg-accent text-accent-ink text-[14.5px] font-semibold hover:bg-on-ink transition-colors"
                >
                  Go to dashboard
                </Link>
              ) : (
                <>
                  <Link
                    href="/signup"
                    className="inline-flex items-center h-[50px] px-[26px] rounded-full bg-accent text-accent-ink text-[14.5px] font-semibold hover:bg-on-ink transition-colors"
                  >
                    Create a merchant account
                  </Link>
                  <Link
                    href="/login"
                    className="inline-flex items-center h-[50px] px-[26px] rounded-full border border-ink-line text-on-ink text-[14.5px] font-medium hover:border-on-ink/40 transition-colors"
                  >
                    Sign in
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-10 pt-11 border-t border-ink-line">
          <div className="font-[family-name:var(--font-display)] text-xl tracking-[-0.02em]">
            THIRDMAN
          </div>

          <div className="flex flex-col gap-3 text-sm text-on-ink-dim">
            <span className="font-mono text-[11px] tracking-[0.16em] text-on-ink-faint">
              SURFACES
            </span>
            <Link href="#surfaces" className="hover:text-on-ink transition-colors">Agent API + MCP</Link>
            <Link href="#surfaces" className="hover:text-on-ink transition-colors">Merchant dashboard</Link>
            <Link href="#surfaces" className="hover:text-on-ink transition-colors">Revenue recovery</Link>
            <Link href="#surfaces" className="hover:text-on-ink transition-colors">Buyer chat</Link>
          </div>

          <div className="flex flex-col gap-3 text-sm text-on-ink-dim">
            <span className="font-mono text-[11px] tracking-[0.16em] text-on-ink-faint">
              HOW IT WORKS
            </span>
            <Link href="#refusal" className="hover:text-on-ink transition-colors">The refusal</Link>
            <Link href="#surfaces" className="hover:text-on-ink transition-colors">The gate order</Link>
            <Link href="#proof" className="hover:text-on-ink transition-colors">Audit log</Link>
            <Link href="#refusal" className="hover:text-on-ink transition-colors">Bounds and caps</Link>
          </div>

          <div className="flex flex-col gap-3 text-sm text-on-ink-dim">
            <span className="font-mono text-[11px] tracking-[0.16em] text-on-ink-faint">
              ACCOUNT
            </span>
            {signedIn ? (
              <Link href="/dashboard" className="hover:text-on-ink transition-colors">Dashboard</Link>
            ) : (
              <>
                <Link href="/signup" className="hover:text-on-ink transition-colors">Create account</Link>
                <Link href="/login" className="hover:text-on-ink transition-colors">Sign in</Link>
              </>
            )}
          </div>
        </div>

        <div className="flex justify-between gap-6 font-mono text-[11.5px] tracking-[0.1em] text-on-ink-faint">
          <span>AMOUNTS IN INTEGER PAISE. ALWAYS.</span>
          <span>© {new Date().getFullYear()} THIRDMAN</span>
        </div>
      </div>
    </footer>
  );
}
