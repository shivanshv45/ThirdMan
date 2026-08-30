"use client";

import { useEffect, useState } from "react";
import { Field, Input, Button, EmptyState } from "@/components/ui";
import {
  getShopifyStatusAction,
  previewShopifySyncAction,
  confirmShopifySyncAction,
  disconnectShopifyAction,
  type ShopifyPreviewState,
  type ShopifyConfirmState,
} from "./actions";

/**
 * L24-3: the Shopify surface, three real states rather than one form —
 * "not connected" (enter a shop domain, a real top-level navigation to
 * /api/shopify/install starts OAuth), "connected, nothing synced yet"
 * and "connected, sync available" (preview real Admin API rows, confirm
 * writes through catalogue-import.ts's existing pipeline — never a
 * second write path). ?shopifyConnected=1 / ?shopifyError=... on the
 * URL come from the OAuth callback route, a real server redirect.
 */
// Read directly off the browser URL rather than next/navigation's
// useSearchParams — that hook forces this whole subtree into a
// Suspense boundary, and a one-time callback-banner read doesn't need
// to participate in server-driven navigation state at all. Guarded for
// SSR (this module's parent is "use client", but the initializer below
// still runs during any server-side render pass), matching the
// window-guard convention this codebase already uses in embed code.
function readCallbackBanners(): { connected: boolean; error: string | null } {
  if (typeof window === "undefined") return { connected: false, error: null };
  const params = new URLSearchParams(window.location.search);
  return { connected: params.get("shopifyConnected") === "1", error: params.get("shopifyError") };
}

export function ShopifyConnect() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [connection, setConnection] = useState<{ shopDomain: string; installedAt: Date | string; lastSyncedAt: Date | string | null } | null>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [preview, setPreview] = useState<ShopifyPreviewState>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ShopifyConfirmState>(null);
  const [previewing, setPreviewing] = useState(false);
  const [{ connected: connectedBanner, error: errorBanner }] = useState(readCallbackBanners);

  useEffect(() => {
    getShopifyStatusAction().then((status) => {
      setConfigured(status.configured);
      setConnection(status.connection);
      setLoading(false);
    });
  }, []);

  async function runPreview() {
    setPreviewing(true);
    setConfirmResult(null);
    const result = await previewShopifySyncAction();
    setPreview(result);
    setPreviewing(false);
  }

  async function runConfirm() {
    if (!preview || "error" in preview) return;
    setConfirming(true);
    const result = await confirmShopifySyncAction(preview.rows);
    setConfirmResult(result);
    setPreview(null);
    setConfirming(false);
    getShopifyStatusAction().then((status) => setConnection(status.connection));
  }

  async function disconnect() {
    await disconnectShopifyAction();
    setConnection(null);
    setPreview(null);
    setConfirmResult(null);
  }

  if (loading) {
    return <p className="text-sm text-on-ink-faint">Checking your Shopify connection…</p>;
  }

  if (!configured) {
    return (
      <EmptyState
        title="Shopify app not configured on this deployment"
        description="SHOPIFY_API_KEY and SHOPIFY_API_SECRET aren't set — see DEPLOYMENT.md. Every other integration path (CLI, Instant Audit, VS Code, WooCommerce) works without this."
      />
    );
  }

  return (
    <div className="space-y-4">
      {connectedBanner && !connection && <p className="text-sm text-allow-bright">Connected. Loading your store…</p>}
      {errorBanner && <p className="text-sm text-deny-bright">{errorBanner}</p>}

      {!connection ? (
        <form action={`/api/shopify/install`} method="get" className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <Field label="Your Shopify store domain" help="A custom app on your own store — real OAuth, real Admin API, no App Store review needed. See DECISIONS.md for what that does and doesn't claim.">
              <Input
                name="shop"
                required
                placeholder="your-store.myshopify.com"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                pattern="^[a-z0-9][a-z0-9-]*\.myshopify\.com$"
                title="e.g. your-store.myshopify.com"
              />
            </Field>
          </div>
          <Button type="submit" variant="primary">
            Connect Shopify
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-lg)] border border-allow-line bg-allow-wash p-3 text-sm space-y-1">
            <p className="text-on-ink font-medium font-mono text-xs">{connection.shopDomain}</p>
            <p className="text-on-ink-dim text-xs">
              Connected {new Date(connection.installedAt).toLocaleString()}
              {connection.lastSyncedAt ? ` · last synced ${new Date(connection.lastSyncedAt).toLocaleString()}` : " · never synced"}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={runPreview} disabled={previewing}>
              {previewing ? "Fetching catalogue…" : "Preview catalogue sync"}
            </Button>
            <button type="button" onClick={disconnect} className="text-xs px-2.5 py-1.5 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-deny-bright hover:border-deny-line transition-colors duration-[var(--dur-fast)]">
              Disconnect
            </button>
          </div>

          {preview && "error" in preview && <p className="text-sm text-deny-bright">{preview.error}</p>}

          {preview && "rows" in preview && preview.rows && (
            <div className="space-y-3">
              <p className="text-xs text-on-ink-faint">
                {preview.rows.length} variant{preview.rows.length === 1 ? "" : "s"} fetched from your live store{preview.isTruncated ? " (more exist — this is the first page; run again after this import completes)" : ""}. Nothing is written until you confirm.
              </p>
              <div className="max-h-64 overflow-y-auto border border-ink-line rounded-[var(--radius)]">
                <table className="w-full text-xs">
                  <tbody>
                    {preview.rows.slice(0, 50).map((row, i) => (
                      <tr key={i} className={row.error ? "text-deny-bright" : "text-on-ink-dim"}>
                        <td className="px-2 py-1 font-mono">{row.sku}</td>
                        <td className="px-2 py-1">{row.name}</td>
                        <td className="px-2 py-1 font-mono">₹{row.priceRupees}</td>
                        <td className="px-2 py-1">{row.stock} in stock</td>
                        <td className="px-2 py-1">{row.error ?? "OK"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button type="button" variant="primary" onClick={runConfirm} disabled={confirming}>
                {confirming ? "Importing…" : `Confirm and import ${preview.rows.filter((r) => !r.error).length} rows`}
              </Button>
            </div>
          )}

          {confirmResult && "error" in confirmResult && <p className="text-sm text-deny-bright">{confirmResult.error}</p>}
          {confirmResult && "rowsImported" in confirmResult && (
            <p className="text-sm text-allow-bright">
              Imported {confirmResult.rowsImported} rows{confirmResult.rowsSkipped ? `, skipped ${confirmResult.rowsSkipped} with errors` : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
