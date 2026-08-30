import type { ReactNode, HTMLAttributes } from "react";

type SurfaceVariant = "flush" | "raised" | "inset" | "glass";

const VARIANT_CLASS: Record<SurfaceVariant, string> = {
  flush: "bg-ink border border-ink-line shadow-sm",
  raised: "bg-ink-raised border border-ink-line shadow-[0_2px_12px_-2px_rgba(0,0,0,0.5),_0_4px_24px_-4px_rgba(0,0,0,0.3)]",
  inset: "bg-ink-overlay border border-ink-line-soft",
  glass: "bg-ink/70 border border-white/10 backdrop-blur-[24px] shadow-[0_8px_30px_rgba(0,0,0,0.3)]",
};

export function Surface({
  variant = "flush",
  className = "",
  children,
  ...rest
}: {
  variant?: SurfaceVariant;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`rounded-[var(--radius-lg)] ${VARIANT_CLASS[variant]} ${className}`} {...rest}>
      {children}
    </div>
  );
}

/**
 * Page title at --t-h2, not --t-h1: this is an application surface, and
 * a 3.5rem title competes with the data it is supposed to be labelling.
 * The landing page still owns the display sizes.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 pb-5 mb-8 border-b border-ink-line">
      <div>
        <h1
          className="text-[var(--t-h2)] font-[family-name:var(--font-display)] font-medium tracking-tight text-on-ink"
        >
          {title}
        </h1>
        {description && <p className="mt-2 text-sm text-on-ink-dim max-w-[var(--measure)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
