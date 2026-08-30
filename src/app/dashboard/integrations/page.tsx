import { requireSessionMerchant } from "@/lib/auth";
import { PageHeader, Surface } from "@/components/ui";
import { WooCommerceDownload } from "./woocommerce-download";
import { CopyPasteArtifacts } from "./copy-paste-artifacts";
import { UnsupportedPlatformSpec } from "./unsupported-platform-spec";
import { ShopifyConnect } from "./shopify-connect";

/**
 * Layer 24-3/24-4/24-5/24-6: four delivery surfaces for merchants not
 * on Next.js/static HTML (the CLI, Layer 20) — a real Shopify OAuth
 * install with a live Admin API catalogue sync, a generated WooCommerce
 * plugin, exact copy-paste artifacts for any other platform, and a
 * written spec for a platform none of the above covers. All four reuse
 * the same audit engine and generator logic the CLI and the Instant
 * Audit already use — see plans/layer-24-onboarding-surfaces.md.
 */
export default async function IntegrationsPage() {
  await requireSessionMerchant();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrations for other platforms"
        description="Not on Next.js or static HTML? Connect Shopify directly, or use WooCommerce, exact copy-paste artifacts, or a written spec for anything else — all reusing the same audit engine and generated artifacts the CLI produces."
      />

      <Surface variant="raised" className="p-5 space-y-4">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Shopify</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            A real OAuth install on your own store. Your catalogue syncs from the Admin API into the same preview-then-confirm import every other source uses — nothing is written until you confirm the rows.
          </p>
        </div>
        <ShopifyConnect />
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">WooCommerce plugin</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            One .php file, pre-configured with this account&apos;s merchant id and publishable key — nothing to type. Upload it in WordPress admin and activate. Idempotent on re-activation, removes cleanly on deactivation.
          </p>
        </div>
        <WooCommerceDownload />
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Copy-paste artifacts</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            For any other platform. Paste your store URL, get the exact block to paste for each failing check and exactly where it goes — not a description, the literal content.
          </p>
        </div>
        <CopyPasteArtifacts />
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Platform we don&apos;t recognise</h2>
          <p className="text-sm text-on-ink-dim mt-1">
            A precise specification for a developer to implement and review — never an instruction for an AI assistant to carry out unsupervised on your live store. Hand it to whoever maintains your site, then verify with <span className="font-mono">npx thirdman doctor</span>.
          </p>
        </div>
        <UnsupportedPlatformSpec />
      </Surface>
    </div>
  );
}
