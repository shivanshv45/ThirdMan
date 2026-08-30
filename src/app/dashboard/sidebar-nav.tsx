"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  RotateCcw,
  Lock,
  Timer,
  Package,
  Tag,
  MessagesSquare,
  Coins,
  ScrollText,
  Gauge,
  KeyRound,
  Scale,
  Code,
  Settings,
  ShieldAlert,
  FlaskConical,
  Landmark,
  BrainCircuit,
  type LucideIcon,
} from "lucide-react";

/* Icons are resolved here, not passed in as props: a React component
   can't cross the server/client boundary, and the nav groups are built
   in the server layout. Keyed by href so a nav item can never end up
   with an icon belonging to a different page. */
const ICONS: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboard,
  "/dashboard/recovery": RotateCcw,
  "/dashboard/escrow": Lock,
  "/dashboard/reservations": Timer,
  "/dashboard/products": Package,
  "/dashboard/offers": Tag,
  "/dashboard/negotiations": MessagesSquare,
  "/dashboard/rewards": Coins,
  "/dashboard/treasury": Landmark,
  "/dashboard/explain": ScrollText,
  "/dashboard/readiness": Gauge,
  "/dashboard/guardian": ShieldAlert,
  "/dashboard/preflight": FlaskConical,
  "/dashboard/memory": BrainCircuit,
  "/dashboard/agents": KeyRound,
  "/dashboard/policies": Scale,
  "/dashboard/embed": Code,
  "/dashboard/settings": Settings,
};

export interface NavItem {
  href: string;
  label: string;
  badge?: number;
  badgeTooltip?: string;
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
 *
 * Density and the hover-revealed badge tooltip are a deliberate pass
 * toward the tool-like precision of the motes editor's own sidebar
 * (compact rows, an icon/badge that explains itself only on hover
 * rather than a permanent caption) — see plans/layer-12.
 */
export function SidebarNav({
  groups,
  statusLabel,
  statusTone = "allow",
}: {
  groups: NavGroup[];
  statusLabel?: string;
  statusTone?: "allow" | "escalate";
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === "/dashboard" ? pathname === href : pathname.startsWith(href));

  const nav = (
    <nav className="flex flex-col gap-5 px-2.5 py-3.5">
      {groups.map((group) => (
        <div key={group.heading}>
          <p className="px-2 mb-1 text-[var(--t-label)] uppercase tracking-[0.08em] text-on-ink-faint font-medium">
            {group.heading}
          </p>
          <div className="flex flex-col gap-px">
            {group.items.map((item) => {
              const active = isActive(item.href);
              const Icon = ICONS[item.href];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`group relative flex items-center justify-between gap-2 rounded-[var(--radius)] px-2 py-1.5 text-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
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
                  <span className="flex items-center gap-2.5 min-w-0">
                    {Icon && (
                      <Icon
                        size={15}
                        strokeWidth={active ? 2 : 1.75}
                        aria-hidden="true"
                        className={`shrink-0 transition-colors duration-[var(--dur-fast)] ${
                          active ? "text-accent" : "text-on-ink-faint group-hover:text-on-ink-dim"
                        }`}
                      />
                    )}
                    <span className="truncate">{item.label}</span>
                  </span>
                  {!!item.badge && (
                    <span className="relative">
                      <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-escalate-wash text-escalate-bright text-[0.6875rem] font-mono font-medium px-1.5">
                        {item.badge}
                      </span>
                      {item.badgeTooltip && (
                        <span
                          role="tooltip"
                          className="pointer-events-none absolute right-0 top-full mt-1.5 w-max max-w-[13rem] rounded-[var(--radius)] border border-ink-line bg-ink-overlay px-2 py-1 text-xs text-on-ink-dim opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.4)] transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 z-10"
                        >
                          {item.badgeTooltip}
                        </span>
                      )}
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
        <span className="font-[family-name:var(--font-display)] text-lg text-on-ink">ThirdMan</span>
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
      <aside className="hidden md:flex md:flex-col w-[var(--sidebar-w)] shrink-0 border-r border-ink-line h-full">
        <div className="flex-1 min-h-0 overflow-y-auto">{nav}</div>
        {statusLabel && (
          <div className="flex items-center gap-1.5 border-t border-ink-line px-3.5 py-2 text-xs text-on-ink-faint shrink-0">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${statusTone === "escalate" ? "bg-escalate" : "bg-allow"}`} />
            <span className="truncate">{statusLabel}</span>
          </div>
        )}
      </aside>
    </>
  );
}
