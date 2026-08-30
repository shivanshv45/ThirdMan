import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getPendingEscalations, getGuardianIncidents, getActiveTaskCount, getPendingMemoryConfirmCount, getActiveReservations, getActiveTheatreRunCount, getActiveReturnRequestCount } from "@/lib/dashboard";
import { getFreezeState } from "@/lib/guardian";
import { getShadowModeState } from "@/lib/shadow-mode";
import { logout } from "./actions";
import { TopNav, type NavGroup } from "./top-nav";
import { KillSwitchBanner } from "./kill-switch-banner";
import { ShadowModeBanner } from "./shadow-mode-banner";
import { Reveal } from "@/components/ui";
import { BackgroundVideo } from "@/components/ui/background-video";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const escalations = await getPendingEscalations(merchant.id);
  const guardianIncidents = await getGuardianIncidents(merchant.id);
  const activeTaskCount = await getActiveTaskCount(merchant.id);
  const activeReservations = await getActiveReservations(merchant.id);
  const pendingMemoryCount = await getPendingMemoryConfirmCount(merchant.id);
  const activeTheatreRunCount = await getActiveTheatreRunCount(merchant.id);
  const activeReturnRequestCount = await getActiveReturnRequestCount(merchant.id);
  const freezeState = await getFreezeState(merchant.id);
  const shadowModeState = await getShadowModeState(merchant.id);

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
        {
          href: "/dashboard/returns",
          label: "Returns desk",
          badge: activeReturnRequestCount,
          badgeTooltip: activeReturnRequestCount
            ? `${activeReturnRequestCount} return request${activeReturnRequestCount === 1 ? "" : "s"} awaiting your decision`
            : undefined,
        },
        {
          href: "/dashboard/reservations",
          label: "Reservations",
          badge: activeReservations.length,
          badgeTooltip: activeReservations.length
            ? `${activeReservations.length} reservation${activeReservations.length === 1 ? "" : "s"} currently holding budget and stock`
            : undefined,
        },
      ],
    },
    {
      heading: "Selling",
      items: [
        { href: "/dashboard/products", label: "Products" },
        { href: "/dashboard/offers", label: "Offers" },
        { href: "/dashboard/negotiations", label: "Negotiations" },
        { href: "/dashboard/rewards", label: "Rewards" },
        { href: "/dashboard/treasury", label: "AI Treasury" },
      ],
    },
    {
      heading: "Trust",
      items: [
        { href: "/dashboard/explain", label: "Decisions" },
        { href: "/dashboard/readiness", label: "Readiness" },
        {
          href: "/dashboard/guardian",
          label: "Guardian",
          badge: guardianIncidents.length,
          badgeTooltip: guardianIncidents.length
            ? `${guardianIncidents.length} agent${guardianIncidents.length === 1 ? "" : "s"} throttled or suspended`
            : undefined,
        },
        { href: "/dashboard/preflight", label: "Preflight" },
      ],
    },
    {
      heading: "Runtime",
      items: [
        {
          href: "/dashboard/tasks",
          label: "Agent Tasks",
          badge: activeTaskCount,
          badgeTooltip: activeTaskCount ? `${activeTaskCount} task${activeTaskCount === 1 ? "" : "s"} active` : undefined,
        },
        {
          href: "/dashboard/memory",
          label: "Memory Bank",
          badge: pendingMemoryCount,
          badgeTooltip: pendingMemoryCount ? `${pendingMemoryCount} stated memor${pendingMemoryCount === 1 ? "y" : "ies"} awaiting confirmation` : undefined,
        },
        {
          href: "/dashboard/theatre",
          label: "Theatre",
          badge: activeTheatreRunCount,
          badgeTooltip: activeTheatreRunCount ? `${activeTheatreRunCount} buyer-agent run${activeTheatreRunCount === 1 ? "" : "s"} still in progress` : undefined,
        },
        {
          href: "/dashboard/control",
          label: "Kill Switch",
          badge: freezeState ? 1 : 0,
          badgeTooltip: freezeState ? "Kill Switch is active" : undefined,
        },
      ],
    },
    {
      heading: "Config",
      items: [
        { href: "/dashboard/setup-conversation", label: "Setup convo" },
        { href: "/dashboard/agents", label: "Agents & caps" },
        { href: "/dashboard/agent-terms", label: "Agent terms" },
        { href: "/dashboard/policies", label: "Policies" },
      ],
    },
    {
      heading: "Platform",
      items: [
        { href: "/dashboard/embed", label: "Embed on site" },
        { href: "/dashboard/cli", label: "Codebase CLI" },
        { href: "/dashboard/integrations", label: "Integrations" },
        { href: "/dashboard/settings", label: "Settings" },
      ],
    },
  ];

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden text-on-ink bg-ink relative">
      <div className="absolute inset-0 z-0 opacity-30">
        <BackgroundVideo srcWebm="/video/slate.webm" srcMp4="/video/slate.mp4" />
      </div>
      <div className="relative z-10 flex flex-col h-full w-full">
        <Reveal />
      {freezeState && <KillSwitchBanner reason={freezeState.reason} frozenAt={freezeState.frozenAt} />}
      {shadowModeState && <ShadowModeBanner enabledAt={shadowModeState.enabledAt} />}

      <TopNav
        groups={groups}
        merchantName={merchant.name}
        statusLabel={escalations.length ? `${escalations.length} pending escalation${escalations.length === 1 ? "" : "s"}` : "All decisions resolved"}
        statusTone={escalations.length ? "escalate" : "allow"}
        logoutAction={logout}
      />

      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        <div className="px-4 md:px-8 py-8 md:py-10 max-w-[var(--shell)] w-full mx-auto pb-32">
          {children}
        </div>
      </main>
      </div>
    </div>
  );
}
