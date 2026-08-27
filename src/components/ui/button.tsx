"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

type Variant = "primary" | "secondary" | "ghost" | "destructive";

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-bright",
  secondary: "bg-ink-overlay text-on-ink border border-ink-line hover:border-on-ink-faint",
  ghost: "text-on-ink-dim hover:text-on-ink hover:bg-ink-overlay",
  destructive: "bg-deny-wash text-deny-bright border border-deny-line hover:bg-deny/20",
};

const SIZE_CLASS = {
  sm: "text-xs px-2.5 py-1.5",
  md: "text-sm px-3.5 py-2",
};

/**
 * Real hover/active/disabled/pending states, driven by the motion
 * tokens — "dead hover states, buttons that snap instead of easing"
 * is a named vibecoded tell (plans/layer-9-interface-and-close.md
 * fact 6). Pending state is real: useFormStatus reflects an actual
 * in-flight Server Action, never a decorative spinner.
 */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  pendingLabel,
  ...rest
}: {
  variant?: Variant;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
  pendingLabel?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  const isPending = pending && rest.type !== "button";
  return (
    <button
      {...rest}
      disabled={isPending || rest.disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium
        transition-[background-color,border-color,color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out)]
        disabled:opacity-50 disabled:cursor-not-allowed
        ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
    >
      {isPending && (
        <span
          aria-hidden="true"
          className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      )}
      {isPending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
