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
  FileSignature,
  Scale,
  Code,
  Settings,
  ShieldAlert,
  FlaskConical,
  Landmark,
  BrainCircuit,
  Clapperboard,
  Power,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";

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
  "/dashboard/theatre": Clapperboard,
  "/dashboard/control": Power,
  "/dashboard/agents": KeyRound,
  "/dashboard/agent-terms": FileSignature,
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
 * Top navigation replacing the sidebar.
 *
 * Row 1 — Main sections arranged as:
 *   [Money] [Selling] [Trust]   ThirdMan   [Runtime] [Setup] [...]
 *
 * Row 2 — Browser-tab-style sub-sections for the active group.
 *
 * Same NavGroup[] and badge data flows in from the server layout —
 * zero logic changes.
 */
export function TopNav({
  groups,
  merchantName,
  statusLabel,
  statusTone = "allow",
  logoutAction,
}: {
  groups: NavGroup[];
  merchantName: string;
  statusLabel?: string;
  statusTone?: "allow" | "escalate";
  logoutAction: string | ((formData: FormData) => void);
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  // Which group is currently active based on pathname
  const activeGroupIndex = groups.findIndex((group) =>
    group.items.some((item) => isActive(item.href)),
  );
  const activeGroup = activeGroupIndex >= 0 ? groups[activeGroupIndex] : groups[0];

  // Split groups: left and right of ThirdMan
  const midpoint = Math.ceil(groups.length / 2);
  const leftGroups = groups.slice(0, midpoint);
  const rightGroups = groups.slice(midpoint);

  return (
    <>
      {/* ─── Desktop Top Navigation ─── */}
      <header className="hidden md:block border-b border-ink-line bg-ink shrink-0 sticky top-0 z-30">
        {/* Row 1: Main section blocks + ThirdMan center */}
        <div className="flex items-stretch h-14">
          {/* Left section blocks */}
          <div className="flex items-stretch flex-1 justify-end gap-1 pr-3">
            {leftGroups.map((group) => {
              const groupActive = group === activeGroup;
              const groupBadgeTotal = group.items.reduce((sum, it) => sum + (it.badge ?? 0), 0);
              return (
                <button
                  key={group.heading}
                  type="button"
                  onClick={() => {
                    const firstHref = group.items[0]?.href;
                    if (firstHref) window.location.href = firstHref;
                  }}
                  className={`relative flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold uppercase tracking-[0.06em] rounded-md my-1.5 transition-all duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                    groupActive
                      ? "bg-accent text-[#ffffff] shadow-sm"
                      : "text-on-ink-dim hover:text-on-ink hover:bg-ink-line-soft"
                  }`}
                >
                  {group.heading}
                  {groupBadgeTotal > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] rounded-full bg-escalate text-[#ffffff] text-[10px] font-mono font-bold px-1 leading-none">
                      {groupBadgeTotal}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ThirdMan center brand with dipped line */}
          <Link
            href="/dashboard"
            className="flex items-center justify-center px-5 group shrink-0"
          >
            <div className="relative flex items-center">
              {/* Left decorative line */}
              <span className="block w-8 h-[1.5px] bg-ink-line rounded-full group-hover:bg-on-ink-faint transition-colors duration-[var(--dur)]" />
              {/* Dip connector left */}
              <svg width="14" height="18" viewBox="0 0 14 18" fill="none" className="shrink-0">
                <path d="M0 2 C4 2, 5 16, 14 16" stroke="var(--ink-line)" strokeWidth="1.5" fill="none" className="group-hover:[stroke:var(--on-ink-faint)] transition-[stroke] duration-[var(--dur)]" />
              </svg>
              {/* Text */}
              <span className="relative text-[17px] font-bold tracking-tight text-on-ink px-0.5 top-[4px]">
                ThirdMan
              </span>
              {/* Dip connector right */}
              <svg width="14" height="18" viewBox="0 0 14 18" fill="none" className="shrink-0">
                <path d="M0 16 C9 16, 10 2, 14 2" stroke="var(--ink-line)" strokeWidth="1.5" fill="none" className="group-hover:[stroke:var(--on-ink-faint)] transition-[stroke] duration-[var(--dur)]" />
              </svg>
              {/* Right decorative line */}
              <span className="block w-8 h-[1.5px] bg-ink-line rounded-full group-hover:bg-on-ink-faint transition-colors duration-[var(--dur)]" />
            </div>
          </Link>

          {/* Right section blocks */}
          <div className="flex items-stretch flex-1 justify-start gap-1 pl-3">
            {rightGroups.map((group) => {
              const groupActive = group === activeGroup;
              const groupBadgeTotal = group.items.reduce((sum, it) => sum + (it.badge ?? 0), 0);
              return (
                <button
                  key={group.heading}
                  type="button"
                  onClick={() => {
                    const firstHref = group.items[0]?.href;
                    if (firstHref) window.location.href = firstHref;
                  }}
                  className={`relative flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold uppercase tracking-[0.06em] rounded-md my-1.5 transition-all duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                    groupActive
                      ? "bg-accent text-[#ffffff] shadow-sm"
                      : "text-on-ink-dim hover:text-on-ink hover:bg-ink-line-soft"
                  }`}
                >
                  {group.heading}
                  {groupBadgeTotal > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] rounded-full bg-escalate text-[#ffffff] text-[10px] font-mono font-bold px-1 leading-none">
                      {groupBadgeTotal}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Status + merchant name + logout — far right */}
            <div className="flex items-center gap-3 ml-auto pr-4">
              {statusLabel && (
                <span className="flex items-center gap-1.5 text-[11px] text-on-ink-faint">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${statusTone === "escalate" ? "bg-escalate animate-pulse" : "bg-allow"}`}
                  />
                  <span className="hidden lg:inline truncate max-w-[150px]">{statusLabel}</span>
                </span>
              )}
              <span className="text-[11px] text-on-ink-faint truncate max-w-[120px] hidden xl:inline">
                {merchantName}
              </span>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="text-[12px] px-3 py-1.5 rounded-full border border-ink-line text-on-ink-dim hover:text-on-ink hover:bg-ink-line-soft transition-all duration-[var(--dur-fast)] font-medium"
                >
                  Log out
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* Row 2: Browser-tab sub-nav for active group */}
        {activeGroup && (
          <div className="flex items-end gap-0 px-4 overflow-x-auto">
            {activeGroup.items.map((item) => {
              const active = isActive(item.href);
              const Icon = ICONS[item.href];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group relative flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap transition-all duration-[var(--dur-fast)] ease-[var(--ease-out)] border-b-2 ${
                    active
                      ? "text-on-ink border-accent"
                      : "text-on-ink-dim hover:text-on-ink border-transparent hover:border-ink-line"
                  }`}
                >
                  {Icon && (
                    <Icon
                      size={14}
                      strokeWidth={active ? 2 : 1.75}
                      aria-hidden="true"
                      className={`shrink-0 ${active ? "text-accent" : "text-on-ink-faint group-hover:text-on-ink-dim"}`}
                    />
                  )}
                  <span>{item.label}</span>
                  {!!item.badge && (
                    <span className="relative">
                      <span className="inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] rounded-full bg-escalate-wash text-escalate-bright text-[10px] font-mono font-bold px-1 leading-none">
                        {item.badge}
                      </span>
                      {item.badgeTooltip && (
                        <span
                          role="tooltip"
                          className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-2 w-max max-w-[13rem] rounded-[var(--radius)] border border-ink-line bg-ink-overlay px-2 py-1 text-xs text-on-ink-dim opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.25)] transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 z-50"
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
        )}
      </header>

      {/* ─── Mobile Navigation ─── */}
      <header className="md:hidden border-b border-ink-line bg-ink shrink-0 sticky top-0 z-30">
        <div className="flex items-center justify-between px-4 h-14">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-on-ink">
            ThirdMan
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileOpen}
            className="p-2 text-on-ink-dim hover:text-on-ink"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        {/* Active group tabs on mobile */}
        {activeGroup && !mobileOpen && (
          <div className="flex items-end gap-0 px-2 overflow-x-auto border-t border-ink-line-soft">
            {activeGroup.items.map((item) => {
              const active = isActive(item.href);
              const Icon = ICONS[item.href];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1 px-3 py-2 text-[12px] font-medium whitespace-nowrap border-b-2 ${
                    active
                      ? "text-on-ink border-accent"
                      : "text-on-ink-dim border-transparent"
                  }`}
                >
                  {Icon && <Icon size={13} strokeWidth={active ? 2 : 1.5} aria-hidden="true" className="shrink-0" />}
                  <span>{item.label}</span>
                  {!!item.badge && (
                    <span className="ml-0.5 inline-flex items-center justify-center min-w-[1rem] h-4 rounded-full bg-escalate-wash text-escalate-bright text-[9px] font-mono font-bold px-1">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        {/* Mobile full menu drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 top-14 bg-ink z-40 overflow-y-auto" role="dialog" aria-modal="true">
            <nav className="px-4 py-4 space-y-4">
              {groups.map((group) => (
                <div key={group.heading}>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-on-ink-faint font-semibold mb-1.5 px-1">
                    {group.heading}
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const active = isActive(item.href);
                      const Icon = ICONS[item.href];
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setMobileOpen(false)}
                          className={`flex items-center gap-2 px-3 py-2 text-sm rounded-[var(--radius)] ${
                            active
                              ? "bg-ink-line text-on-ink font-semibold"
                              : "text-on-ink-dim hover:text-on-ink hover:bg-ink-line-soft"
                          }`}
                        >
                          {Icon && <Icon size={15} strokeWidth={active ? 2 : 1.75} aria-hidden="true" className="shrink-0" />}
                          <span>{item.label}</span>
                          {!!item.badge && (
                            <span className="ml-auto inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] rounded-full bg-escalate-wash text-escalate-bright text-[10px] font-mono font-bold px-1">
                              {item.badge}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="border-t border-ink-line pt-3 mt-3 flex items-center justify-between">
                <span className="text-xs text-on-ink-faint">{merchantName}</span>
                <form action={logoutAction}>
                  <button type="submit" className="text-xs px-3 py-1.5 rounded-full border border-ink-line text-on-ink-dim hover:text-on-ink font-medium">
                    Log out
                  </button>
                </form>
              </div>
            </nav>
          </div>
        )}
      </header>
    </>
  );
}
