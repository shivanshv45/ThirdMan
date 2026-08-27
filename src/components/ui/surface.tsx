import type { ReactNode, HTMLAttributes } from "react";

type SurfaceVariant = "flush" | "raised" | "inset";

const VARIANT_CLASS: Record<SurfaceVariant, string> = {
  flush: "bg-ink border border-ink-line",
  raised: "bg-ink-raised border border-ink-line shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset]",
  inset: "bg-ink-overlay border border-ink-line-soft",
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
    <header className="flex flex-wrap items-start justify-between gap-4 mb-8">
      <div>
        <h1
          className="text-[var(--t-h1)] font-[family-name:var(--font-display)] font-medium tracking-tight text-on-ink"
        >
          {title}
        </h1>
        {description && <p className="mt-1.5 text-sm text-on-ink-dim max-w-[var(--measure)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
