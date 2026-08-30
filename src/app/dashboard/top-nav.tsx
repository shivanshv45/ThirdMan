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
        <div className="flex items-stretch h-[64px] w-full px-4 md:px-6 relative">
          {/* Subtle bottom border for row 1 */}
          <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-ink-line-soft/50" />

          {/* Left section blocks */}
          <div className="flex items-center flex-1 justify-around gap-2 pr-4 z-10">
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
                  className={`relative flex items-center justify-center px-6 py-3 text-[16px] font-black uppercase tracking-[0.1em] rounded-lg transition-all duration-500 ease-[var(--ease-out)] group/tab ${
                    groupActive
                      ? "text-on-ink scale-[1.05]"
                      : "text-on-ink-dim hover:text-on-ink hover:bg-ink-line-soft/80"
                  }`}
                >
                  {/* Glassmorphic active background */}
                  {groupActive && (
                    <div className="absolute inset-0 rounded-lg bg-gradient-to-b from-on-ink/10 to-transparent border border-on-ink/20 pointer-events-none shadow-[inset_0_1px_4px_rgba(255,255,255,0.1)]" />
                  )}
                  
                  <span className="relative z-10 flex items-center gap-2">
                    {group.heading}
                    {groupBadgeTotal > 0 && (
                      <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] rounded-full text-[10px] font-mono font-bold px-1 leading-none transition-colors ${groupActive ? 'bg-ink border border-on-ink/20 text-on-ink' : 'bg-escalate text-[#ffffff]'}`}>
                        {groupBadgeTotal}
                      </span>
                    )}
                  </span>

                  {/* Glowing beam indicator */}
                  {groupActive && (
                    <span className="absolute -bottom-[1px] left-1/2 -translate-x-1/2 w-1/2 h-[2px] rounded-full bg-gradient-to-r from-transparent via-on-ink to-transparent opacity-90 shadow-[0_0_12px_rgba(255,255,255,1)]" />
                  )}
                </button>
              );
            })}
          </div>

          {/* ThirdMan center brand with refined dipped line */}
          <Link
            href="/dashboard"
            className="flex items-center justify-center px-8 group shrink-0 z-10"
          >
            <div className="relative flex items-center">
              {/* Left decorative line */}
              <span className="block w-16 h-[2px] bg-gradient-to-r from-transparent via-on-ink-dim/40 to-on-ink-dim group-hover:to-accent transition-all duration-500" />
              
              {/* Dip connector left */}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="shrink-0 text-on-ink-dim group-hover:text-accent transition-all duration-500">
                <path d="M0 2 C 10 2, 12 22, 24 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              
              {/* Text */}
              <div className="relative flex items-center px-1.5 top-[8px]">
                <span className="text-[22px] font-black tracking-tight text-on-ink drop-shadow-sm transition-colors duration-500 group-hover:text-white">
                  Third
                </span>
                <span className="text-[22px] font-black tracking-tight text-accent drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.5)]">
                  Man
                </span>
              </div>
              
              {/* Dip connector right */}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="shrink-0 text-on-ink-dim group-hover:text-accent transition-all duration-500">
                <path d="M0 22 C 12 22, 14 2, 24 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              
              {/* Right decorative line */}
              <span className="block w-16 h-[2px] bg-gradient-to-l from-transparent via-on-ink-dim/40 to-on-ink-dim group-hover:to-accent transition-all duration-500" />
            </div>
          </Link>

          {/* Right section blocks */}
          <div className="flex items-center flex-1 justify-around gap-2 pl-4 z-10">
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
                  className={`relative flex items-center justify-center px-6 py-3 text-[16px] font-black uppercase tracking-[0.1em] rounded-lg transition-all duration-500 ease-[var(--ease-out)] group/tab ${
                    groupActive
                      ? "text-on-ink scale-[1.05]"
                      : "text-on-ink-dim hover:text-on-ink hover:bg-ink-line-soft/80"
                  }`}
                >
                  {/* Glassmorphic active background */}
                  {groupActive && (
                    <div className="absolute inset-0 rounded-lg bg-gradient-to-b from-on-ink/10 to-transparent border border-on-ink/20 pointer-events-none shadow-[inset_0_1px_4px_rgba(255,255,255,0.1)]" />
                  )}
                  
                  <span className="relative z-10 flex items-center gap-2">
                    {group.heading}
                    {groupBadgeTotal > 0 && (
                      <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] rounded-full text-[10px] font-mono font-bold px-1 leading-none transition-colors ${groupActive ? 'bg-ink border border-on-ink/20 text-on-ink' : 'bg-escalate text-[#ffffff]'}`}>
                        {groupBadgeTotal}
                      </span>
                    )}
                  </span>

                  {/* Glowing beam indicator */}
                  {groupActive && (
                    <span className="absolute -bottom-[1px] left-1/2 -translate-x-1/2 w-1/2 h-[2px] rounded-full bg-gradient-to-r from-transparent via-on-ink to-transparent opacity-90 shadow-[0_0_12px_rgba(255,255,255,1)]" />
                  )}
                </button>
              );
            })}

          </div>
        </div>

        {/* Row 2: Browser-tab sub-nav for active group (Evenly distributed Edge-to-Edge) */}
        {activeGroup && (
          <div className="flex items-end gap-1 w-full px-2 pt-1.5 bg-ink-overlay/30 border-t border-ink-line-soft shadow-[inset_0_4px_6px_-4px_rgba(0,0,0,0.05)]">
            {activeGroup.items.map((item) => {
              const active = isActive(item.href);
              const Icon = ICONS[item.href];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group relative flex-1 flex items-center justify-center gap-2 px-4 py-2 text-[13px] font-semibold whitespace-nowrap transition-all duration-[var(--dur-fast)] ease-[var(--ease-out)] rounded-t-lg border-2 ${
                    active
                      ? "text-on-ink bg-ink border-accent z-10"
                      : "text-on-ink-dim hover:text-on-ink bg-transparent border-transparent hover:bg-ink-line-soft/40 z-0"
                  }`}
                >

                  {Icon && (
                    <Icon
                      size={16}
                      strokeWidth={active ? 2.5 : 2}
                      aria-hidden="true"
                      className={`shrink-0 transition-transform group-hover:scale-110 ${active ? "text-accent" : "text-on-ink-faint"}`}
                    />
                  )}
                  <span>{item.label}</span>
                  {!!item.badge && (
                    <span className="relative ml-1">
                      <span className="inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] rounded-full bg-escalate-wash text-escalate-bright text-[10px] font-mono font-black px-1 leading-none">
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
              </div>
            </nav>
          </div>
        )}
      </header>
    </>
  );
}
