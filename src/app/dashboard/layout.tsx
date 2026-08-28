import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getPendingEscalations } from "@/lib/dashboard";
import { logout } from "./actions";
import { SidebarNav, type NavGroup } from "./sidebar-nav";
import { Reveal } from "@/components/ui";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const escalations = await getPendingEscalations(merchant.id);

  const groups: NavGroup[] = [
    {
      heading: "Money",
      items: [
        {
          href: "/dashboard",
          label: "Overview",
          badge: escalations.length,
          badgeTooltip: escalations.length
            ? `${escalations.length} money action${escalations.length === 1 ? "" : "s"} waiting on a decision`
            : undefined,
        },
        { href: "/dashboard/recovery", label: "Recovery" },
        { href: "/dashboard/escrow", label: "Escrow" },
      ],
    },
    {
      heading: "Selling",
      items: [
        { href: "/dashboard/products", label: "Products" },
        { href: "/dashboard/offers", label: "Offers" },
        { href: "/dashboard/negotiations", label: "Negotiations" },
        { href: "/dashboard/rewards", label: "Rewards" },
      ],
    },
    {
      heading: "Trust",
      items: [
        { href: "/dashboard/explain", label: "Decisions" },
        { href: "/dashboard/readiness", label: "Readiness" },
      ],
    },
    {
      heading: "Setup",
      items: [
        { href: "/dashboard/agents", label: "Agents & caps" },
        { href: "/dashboard/policies", label: "Policies" },
        { href: "/dashboard/embed", label: "Embed on your site" },
        { href: "/dashboard/settings", label: "Settings" },
      ],
    },
  ];

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0">
      <Reveal />
      <SidebarNav
        groups={groups}
        statusLabel={escalations.length ? `${escalations.length} pending escalation${escalations.length === 1 ? "" : "s"}` : "All decisions resolved"}
        statusTone={escalations.length ? "escalate" : "allow"}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="hidden md:flex items-center justify-between px-6 h-[var(--nav-h)] border-b border-ink-line shrink-0">
          <span className="font-[family-name:var(--font-display)] text-lg text-on-ink">{merchant.name}</span>
          <form action={logout}>
            <button
              type="submit"
              className="text-sm px-3 py-1.5 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)]"
            >
              Log out
            </button>
          </form>
        </div>
        <main className="flex-1 min-w-0 px-4 md:px-8 py-6 md:py-8 max-w-[var(--shell)] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
