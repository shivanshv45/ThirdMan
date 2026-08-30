import { headers } from "next/headers";
import { requireSessionMerchant } from "@/lib/auth";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { getRazorpayConnectionStatus } from "@/lib/dashboard";
import { getMerchantWebhooks, getRecentDeliveries } from "@/lib/merchant-webhooks";
import { PageHeader, Surface, Field, Input, Select, Button, EmptyState, DetailsToggle, Table, Thead, Tr, Th, Td, DecisionBadge } from "@/components/ui";
import { updateOrigins, updateAppearance, toggleEmbedStatus, updateWebhook, toggleWebhookStatus, sendTestDelivery, retryDeliveryAction } from "./actions";
import { RotateEmbedKeyButton, RegisterWebhookForm } from "./secret-reveal";
import { LivePreview } from "./live-preview";
import { IntegrationVerifyPanel } from "./integration-verify-panel";

/**
 * The merchant's install surface for the embeddable widget (Layer 10,
 * L10-6) — where they get their snippet, configure it, and see what's
 * happening with their registered webhook. In the Setup nav group,
 * beside Agents & caps / Policies / Settings.
 */
export default async function EmbedPage() {
  const merchant = await requireSessionMerchant();
  const [config, razorpayStatus, webhooks, deliveries] = await Promise.all([
    getOrCreateEmbedConfig(merchant.id),
    getRazorpayConnectionStatus(merchant.id),
    getMerchantWebhooks(merchant.id),
    getRecentDeliveries(merchant.id),
  ]);

  const headersList = await headers();
  const host = headersList.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const appOrigin = `${protocol}://${host}`;
  const snippet = `<script async src="${appOrigin}/api/embed/v1.js" data-embed-key="${config.publishableKey}"></script>`;

  const features = (config.features ?? {}) as { negotiation?: boolean; offers?: boolean };
  const webhook = webhooks[0]; // one webhook per merchant for now — the common case, and the UI this page needs

  return (
    <div className="space-y-8">
      <PageHeader
        title="Embed on your site"
        description="Paste one script tag into your own website and the whole chat, cart, and checkout flow runs there — on your domain, bounded by the same gate and audit trail as everything else."
      />

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Your snippet</h2>

        <div className="space-y-1.5">
          {!razorpayStatus.connected && (
            <p className="text-sm text-escalate-bright bg-escalate-wash border border-escalate-line rounded-[var(--radius)] px-3 py-2">
              Connect Razorpay in Settings before pasting this — buyers won&apos;t be able to pay until you do.
            </p>
          )}
          {config.allowedOrigins.length === 0 && (
            <p className="text-sm text-escalate-bright bg-escalate-wash border border-escalate-line rounded-[var(--radius)] px-3 py-2">
              Add at least one allowed origin below — the widget refuses to load anywhere until you do.
            </p>
          )}
        </div>

        <pre className="font-mono text-xs bg-ink border border-ink-line rounded-[var(--radius)] px-3 py-2.5 overflow-x-auto text-on-ink">
          {snippet}
        </pre>

        <div className="flex items-center gap-3">
          <RotateEmbedKeyButton appOrigin={appOrigin} />
          <form action={toggleEmbedStatus}>
            <input type="hidden" name="status" value={config.status === "active" ? "disabled" : "active"} />
            <Button type="submit" size="sm" variant={config.status === "active" ? "secondary" : "primary"}>
              {config.status === "active" ? "Disable embed" : "Re-enable embed"}
            </Button>
          </form>
        </div>
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Where it can run</h2>
        <p className="text-sm text-on-ink-dim">
          Exact origins only (scheme + domain + port) — one per line. An empty list means the widget is blocked everywhere, not open everywhere.
        </p>
        <form action={updateOrigins} className="space-y-3 max-w-md">
          <Field label="Allowed origins">
            <textarea
              name="origins"
              defaultValue={config.allowedOrigins.join("\n")}
              rows={4}
              placeholder="https://shop.example.com"
              className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink font-mono placeholder:text-on-ink-faint outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
            />
          </Field>
          <Button type="submit" variant="primary" pendingLabel="Saving…">
            Save origins
          </Button>
        </form>
      </Surface>

      <IntegrationVerifyPanel appOrigin={appOrigin} />

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">How it looks</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form action={updateAppearance} className="space-y-3 max-w-sm">
            <Field label="Display name" help="Falls back to your account name if left blank.">
              <Input name="displayName" defaultValue={config.displayName ?? ""} placeholder={merchant.name} />
            </Field>
            <Field label="Greeting" help="The first line shown before a buyer sends a message.">
              <Input name="greeting" defaultValue={config.greeting ?? ""} placeholder="Ask what we sell, get a recommendation…" />
            </Field>
            <Field label="Accent colour" help="A hex colour, e.g. #1a8f5e. Leave blank for the platform default.">
              <Input name="accentColor" type="text" defaultValue={config.accentColor ?? ""} placeholder="#0d94fb" className="font-mono" />
            </Field>
            <Field label="Position">
              <Select name="position" defaultValue={config.position}>
                <option value="bottom_right">Bottom right</option>
                <option value="bottom_left">Bottom left</option>
              </Select>
            </Field>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-on-ink-dim">
                <input type="checkbox" name="negotiationEnabled" defaultChecked={features.negotiation ?? true} className="accent-accent" />
                Allow price negotiation
              </label>
              <label className="flex items-center gap-2 text-sm text-on-ink-dim">
                <input type="checkbox" name="offersEnabled" defaultChecked={features.offers ?? true} className="accent-accent" />
                Show bundle upsells
              </label>
            </div>
            <Button type="submit" variant="primary" pendingLabel="Saving…">
              Save appearance
            </Button>
          </form>

          <div>
            <p className="text-xs text-on-ink-faint mb-2">Live preview — the real widget, your real config</p>
            <LivePreview publishableKey={config.publishableKey} />
          </div>
        </div>
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Notifications</h2>
        <p className="text-sm text-on-ink-dim">
          Register a URL on your own server and it gets a signed, retried POST every time a real order is paid, held, or refunded — so your inventory system stays in sync even when nobody&apos;s looking at the browser.
        </p>

        {!webhook ? (
          <RegisterWebhookForm />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between max-w-md">
              <div>
                <p className="text-sm text-on-ink font-mono break-all">{webhook.url}</p>
                <p className="text-xs text-on-ink-faint mt-1">Subscribed to: {webhook.subscribedEvents.join(", ")}</p>
              </div>
              <DecisionBadge decision={webhook.status === "active" ? "allow" : "n/a"} label={webhook.status === "active" ? "Active" : "Disabled"} />
            </div>

            <form action={updateWebhook} className="space-y-3 max-w-md">
              <input type="hidden" name="webhookId" value={webhook.id} />
              <Field label="Endpoint URL">
                <Input name="url" type="url" defaultValue={webhook.url} required />
              </Field>
              <fieldset className="space-y-1.5">
                <legend className="text-sm text-on-ink-dim font-medium mb-1">Events</legend>
                {[
                  { value: "order.paid", label: "order.paid" },
                  { value: "order.held", label: "order.held" },
                  { value: "order.refunded", label: "order.refunded" },
                  { value: "stock.changed", label: "stock.changed" },
                ].map((e) => (
                  <label key={e.value} className="flex items-center gap-2 text-sm text-on-ink-dim">
                    <input type="checkbox" name="events" value={e.value} defaultChecked={webhook.subscribedEvents.includes(e.value)} className="accent-accent" />
                    {e.label}
                  </label>
                ))}
              </fieldset>
              <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" size="sm" pendingLabel="Saving…">
                  Save
                </Button>
              </div>
            </form>

            <div className="flex items-center gap-2">
              <form action={sendTestDelivery}>
                <input type="hidden" name="webhookId" value={webhook.id} />
                <Button type="submit" size="sm" pendingLabel="Sending…">
                  Send a test event
                </Button>
              </form>
              <form action={toggleWebhookStatus}>
                <input type="hidden" name="webhookId" value={webhook.id} />
                <input type="hidden" name="status" value={webhook.status === "active" ? "disabled" : "active"} />
                <Button type="submit" size="sm" variant={webhook.status === "active" ? "destructive" : "secondary"}>
                  {webhook.status === "active" ? "Disable" : "Re-enable"}
                </Button>
              </form>
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-medium text-on-ink mb-2">Delivery log</h3>
          {deliveries.length === 0 ? (
            <EmptyState title="No deliveries yet" description="Real deliveries appear here once a real order is paid, or you send a test event." />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Event</Th>
                  <Th>Status</Th>
                  <Th numeric>Attempts</Th>
                  <Th>Last attempt</Th>
                  <Th>Details</Th>
                </Tr>
              </Thead>
              <tbody>
                {deliveries.map((d) => (
                  <Tr key={d.id}>
                    <Td>
                      <span className="font-mono text-xs">{d.eventType}</span>
                    </Td>
                    <Td>
                      <DecisionBadge
                        decision={d.status === "delivered" ? "allow" : d.status === "pending" ? "n/a" : "deny"}
                        label={d.status}
                      />
                    </Td>
                    <Td numeric>{d.attemptCount}</Td>
                    <Td>
                      <span className="text-xs text-on-ink-faint">{d.lastAttemptAt ? new Date(d.lastAttemptAt).toLocaleString() : "—"}</span>
                    </Td>
                    <Td>
                      <DetailsToggle summary="Show details">
                        <div className="space-y-1">
                          {d.lastStatusCode !== null && <p>HTTP {d.lastStatusCode}</p>}
                          {d.lastError && <p className="text-deny-bright">{d.lastError}</p>}
                          {d.nextAttemptAt && <p>Next attempt: {new Date(d.nextAttemptAt).toLocaleString()}</p>}
                          {(d.status === "failed" || d.status === "exhausted") && (
                            <form action={retryDeliveryAction} className="pt-1">
                              <input type="hidden" name="deliveryId" value={d.id} />
                              <Button type="submit" size="sm" pendingLabel="Retrying…">
                                Retry
                              </Button>
                            </form>
                          )}
                        </div>
                      </DetailsToggle>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Surface>
    </div>
  );
}
