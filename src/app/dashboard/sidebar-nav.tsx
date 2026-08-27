"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  badge?: number;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * Grouped sidebar replacing the flat 11-link top bar (plans/layer-9,
 * fact 3). Groups reflect what a merchant actually does with each
 * page (Money / Selling / Trust / Setup), not the build order.
 * Collapses to a real drawer under 768px rather than wrapping.
 */
export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === "/dashboard" ? pathname === href : pathname.startsWith(href));

  const nav = (
    <nav className="flex flex-col gap-6 px-3 py-4">
      {groups.map((group) => (
        <div key={group.heading}>
          <p className="px-2.5 mb-1.5 text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">
            {group.heading}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`relative flex items-center justify-between gap-2 rounded-[var(--radius)] px-2.5 py-1.5 text-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                    active
                      ? "bg-accent-wash text-on-ink font-medium"
                      : "text-on-ink-dim hover:text-on-ink hover:bg-ink-overlay"
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-accent"
                    />
                  )}
                  <span>{item.label}</span>
                  {!!item.badge && (
                    <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-escalate-wash text-escalate-bright text-[0.6875rem] font-mono font-medium px-1.5">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Mobile top bar with a real drawer toggle */}
      <div className="md:hidden flex items-center justify-between px-4 h-[var(--nav-h)] border-b border-ink-line bg-ink">
        <span className="font-[family-name:var(--font-display)] text-lg text-on-ink">Northside</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          className="flex flex-col gap-1 p-2"
        >
          <span className={`block h-0.5 w-5 bg-on-ink transition-transform duration-[var(--dur-fast)] ${open ? "translate-y-1.5 rotate-45" : ""}`} />
          <span className={`block h-0.5 w-5 bg-on-ink transition-opacity duration-[var(--dur-fast)] ${open ? "opacity-0" : ""}`} />
          <span className={`block h-0.5 w-5 bg-on-ink transition-transform duration-[var(--dur-fast)] ${open ? "-translate-y-1.5 -rotate-45" : ""}`} />
        </button>
      </div>

      {open && (
        <div
          className="md:hidden fixed inset-0 top-[var(--nav-h)] bg-ink z-40 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          {nav}
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:block w-[var(--sidebar-w)] shrink-0 border-r border-ink-line h-full overflow-y-auto">
        {nav}
      </aside>
    </>
  );
}
