import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getRecentNegotiations, getNegotiableVariants } from "@/lib/dashboard";
import { formatPaise } from "@/lib/money";
import { setNegotiationFloor } from "./actions";
import { NegotiationList } from "./negotiation-list";
import { PageHeader, Surface, Stat, DetailsToggle, Input, Button, EmptyState, SectionExplainer } from "@/components/ui";
import { NegotiationsChatBar } from "./negotiations-chat-bar";

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  agreed: "Agreed",
  refused_turns_exhausted: "Refused — floor never reached",
  expired: "Expired",
  redeemed: "Redeemed",
};

export default async function NegotiationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;

  const [negotiations, variants] = await Promise.all([
    getRecentNegotiations(merchant.id, 50),
    getNegotiableVariants(merchant.id),
  ]);

  const refusedCount = negotiations.filter((n) => n.status === "refused_turns_exhausted").length;
  const agreedCount = negotiations.filter((n) => n.status === "agreed" || n.status === "redeemed").length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Negotiation"
        description="A buyer — an AI agent or a person in chat — can ask for a better price on any variant you've set a floor for. Your agent will counter, but never below the floor you set here. A refusal below is evidence the floor held, not a gap."
      />

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      <NegotiationsChatBar />

      <Surface variant="raised" className="p-6 relative">
        <div className="grid grid-cols-3 gap-6">
          <Stat label="Total negotiations" value={negotiations.length} />
          <Stat label="Agreed" value={agreedCount} tone="allow" />
          <Stat label="Refused — floor held" value={refusedCount} tone="deny" />
        </div>
        <SectionExplainer
          title="how negotiation works"
          steps={[
            { label: "Buyer asks for a discount", detail: "Human or agent" },
            { label: "Agent counters", detail: "Never below your floor", tone: "accent" },
          ]}
          branches={[
            { condition: "Floor reached", steps: [{ label: "Agreed", detail: "Buyer can redeem the price", tone: "allow" }] },
            { condition: "Turns run out first", steps: [{ label: "Refused", detail: "The floor held", tone: "deny" }] },
          ]}
        />
      </Surface>

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1.5">Negotiation floors</h2>
        <p className="text-xs text-on-ink-faint mb-3 max-w-[var(--measure)]">
          A variant with no floor set is not negotiable at all — that&apos;s the default, never a permissive one. Set a floor to allow negotiation on it.
        </p>
        <ul className="space-y-2">
          {variants.map((v) => (
            <li
              key={v.variantId}
              className="rounded-[var(--radius)] border border-ink-line bg-ink-overlay px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
            >
              <div className="text-sm">
                <span className="font-medium text-on-ink">{v.productName}</span>
                <span className="text-on-ink-dim ml-2 font-mono">
                  {v.sku} — catalogue {formatPaise(v.pricePaise)}
                  {v.floorPricePaise !== null && <> — floor {formatPaise(v.floorPricePaise)}</>}
                </span>
                {v.belowCostFloorAcknowledged && (
                  <span className="ml-2 text-xs text-escalate-bright bg-escalate-wash border border-escalate-line rounded-full px-1.5 py-0.5">
                    below cost, acknowledged
                  </span>
                )}
              </div>
              <DetailsToggle summary={v.floorPricePaise === null ? "Set floor" : "Edit floor"}>
                <form action={setNegotiationFloor} className="flex items-center gap-2 font-sans">
                  <input type="hidden" name="variantId" value={v.variantId} />
                  <Input
                    name="floorPriceRupees"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Leave blank to clear"
                    defaultValue={v.floorPricePaise !== null ? (v.floorPricePaise / 100).toFixed(2) : ""}
                    className="w-32"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-on-ink-dim whitespace-nowrap">
                    <input type="checkbox" name="belowCostAcknowledged" defaultChecked={v.belowCostFloorAcknowledged} />
                    Below cost, OK
                  </label>
                  <Button type="submit" size="sm" pendingLabel="Saving…">
                    Save
                  </Button>
                </form>
              </DetailsToggle>
            </li>
          ))}
        </ul>
      </Surface>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">
          Recent negotiations
        </h2>
        {negotiations.length === 0 ? (
          <EmptyState title="No negotiations yet" description="They appear here as buyers open them, over MCP or the chat widget." />
        ) : (
          <NegotiationList negotiations={negotiations} statusLabels={STATUS_LABELS} />
        )}
      </section>
    </div>
  );
}
