import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const inputClass =
  "w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink " +
  "placeholder:text-on-ink-faint outline-none transition-colors duration-[var(--dur-fast)] " +
  "focus:border-accent focus:ring-1 focus:ring-accent/40";

export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-on-ink-dim font-medium">{label}</span>
      {children}
      {help && !error && <span className="text-xs text-on-ink-faint">{help}</span>}
      {error && <span className="text-xs text-deny-bright">{error}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}
