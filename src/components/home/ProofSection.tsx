/**
 * A single-merchant illustration of what the decision stream looks like at
 * volume — not a live cross-merchant aggregate. This is a multi-tenant
 * platform with no single "the merchant" (see CLAUDE.md); a real number
 * here would have to be one merchant's, chosen arbitrarily, which is worse
 * than being honest that this is a worked example. Same treatment as the
 * "refusal" example in CodaHero — explicitly labelled, never implied real.
 * See DECISIONS.md, "The landing hero's ... 'refusal' example is explicitly
 * labelled illustrative," which set this precedent.
 */

const STATS = [
  { label: "MONEY MOVED", value: "₹8,42,190.00", tone: "" },
  { label: "REFUSALS", value: "1,204", tone: "text-deny" },
  { label: "ARITHMETIC, NO MODEL", value: "96.4%", tone: "text-accent" },
  { label: "MEDIAN GATE TIME", value: "41 ms", tone: "" },
] as const;

export function ProofSection() {
  return (
    <section id="proof" className="relative px-6 md:px-10 pb-[120px]">
      <div className="max-w-[1180px] mx-auto">
        <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-on-ink-dim mb-4">
          One merchant&apos;s numbers, illustrative — every merchant sees only their own
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-on-ink/[0.12] border border-on-ink/[0.12] rounded-2xl overflow-hidden">
          {STATS.map((s) => (
            <div key={s.label} className="bg-ink p-[30px_24px] flex flex-col gap-2">
              <span className="font-mono text-[11px] tracking-[0.16em] text-on-ink-faint">
                {s.label}
              </span>
              <span className={`font-mono text-[30px] tabular-nums tracking-[-0.02em] ${s.tone}`}>
                {s.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
