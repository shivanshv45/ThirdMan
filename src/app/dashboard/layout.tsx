import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getPendingEscalations, getGuardianIncidents, getActiveTaskCount, getPendingMemoryConfirmCount, getActiveReservations, getActiveTheatreRunCount, getActiveReturnRequestCount } from "@/lib/dashboard";
import { getFreezeState } from "@/lib/guardian";
import { getShadowModeState } from "@/lib/shadow-mode";
import { logout } from "./actions";
import { TopNav, type NavGroup } from "./top-nav";
import { KillSwitchBanner } from "./kill-switch-banner";
import { ShadowModeBanner } from "./shadow-mode-banner";
import { Reveal, LiveActivityProvider, ActivityFeed } from "@/components/ui";
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
      // The coin program and the treasury that funds it are one product
      // idea, not two unrelated pages filed under Selling: a buyer earns
      // coins on a capture and redeems them for AI credits, and the
      // treasury is where the money backing that comes from.
      heading: "Rewards",
      items: [
        { href: "/dashboard/rewards", label: "Coin program" },
        { href: "/dashboard/treasury", label: "AI Treasury" },
      ],
    },
    {
      heading: "Selling",
      items: [
        { href: "/dashboard/products", label: "Products" },
        { href: "/dashboard/offers", label: "Offers" },
        { href: "/dashboard/negotiations", label: "Negotiations" },
      ],
    },
    {
      // Policies and Agent terms sit here rather than under a config
      // heading because they are bounds the gate reads at decision time,
      // not preferences — the same place a merchant looks to check that
      // a limit is real belongs next to the decisions it produced.
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
        { href: "/dashboard/policies", label: "Policies" },
        { href: "/dashboard/agent-terms", label: "Agent terms" },
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
        { href: "/dashboard/agents", label: "Agents & caps" },
        {
          href: "/dashboard/control",
          label: "Kill Switch",
          badge: freezeState ? 1 : 0,
          badgeTooltip: freezeState ? "Kill Switch is active" : undefined,
        },
      ],
    },
    {
      // Everything about wiring this product into a merchant's own
      // stack — their site, their store platform, their codebase — plus
      // the account settings those connections depend on.
      heading: "Connect",
      items: [
        { href: "/dashboard/embed", label: "Embed on site" },
        { href: "/dashboard/integrations", label: "Integrations" },
        { href: "/dashboard/cli", label: "Codebase CLI" },
        { href: "/dashboard/setup-conversation", label: "Setup convo" },
        { href: "/dashboard/settings", label: "Settings" },
      ],
    },
  ];

  return (
    <LiveActivityProvider>
    <div className="flex flex-col h-screen w-full overflow-hidden text-on-ink bg-ink relative">
      {/* Background Video Layer */}
      <div className="absolute inset-0 z-0 opacity-40">
        <BackgroundVideo srcWebm="/video/slate.webm" srcMp4="/video/slate.mp4" playbackRate={0.55} />
      </div>
      
      {/* Main App Layout */}
      <div className="relative z-10 flex flex-col h-full w-full bg-ink/40 backdrop-blur-sm">
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
        <div className="px-4 md:px-8 py-8 md:py-10 max-w-[var(--shell)] w-full mx-auto pb-32 relative z-10">
          {children}
        </div>
      </main>

      {/* The agent's work, visible on every page rather than only on the
          Overview's audit trail. Driven by the real decision stream. */}
      <ActivityFeed />
      </div>
    </div>
    </LiveActivityProvider>
  );
}
