import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-ink-line">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function Thead({ children }: { children: ReactNode }) {
  return <thead className="bg-ink-overlay">{children}</thead>;
}

export function Th({
  numeric,
  children,
  ...rest
}: { numeric?: boolean; children: ReactNode } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      className={`px-4 py-2.5 text-[var(--t-label)] uppercase tracking-[0.06em] font-medium text-on-ink-faint border-b border-ink-line ${
        numeric ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-b border-ink-line-soft last:border-0 hover:bg-ink-overlay/50 transition-colors duration-[var(--dur-fast)]">{children}</tr>;
}

export function Td({
  numeric,
  children,
  ...rest
}: { numeric?: boolean; children: ReactNode } & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...rest}
      className={`px-4 py-3 align-top ${numeric ? "text-right font-mono tabular-nums" : "text-left"}`}
    >
      {children}
    </td>
  );
}
