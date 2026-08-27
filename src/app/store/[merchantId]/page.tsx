import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getMerchantStorefrontInfo, getPublicCatalogue } from "@/lib/storefront-catalogue";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";
import { formatPaise as rupees } from "@/lib/money";
import { BuyButton } from "./buy-button";
import { ChatWidget } from "./chat-widget";

/**
 * Links the agent-discovery manifest (Layer 5-5) in the page's <head>, so
 * a crawler or agent landing on this URL can find it without already
 * knowing the path — the storefront's own equivalent of a favicon link.
 */
export async function generateMetadata({ params }: { params: Promise<{ merchantId: string }> }): Promise<Metadata> {
  const { merchantId } = await params;
  const merchant = await getMerchantStorefrontInfo(merchantId);
  return {
    title: merchant?.name,
    other: { "agent-manifest": `/store/${merchantId}/manifest.json` },
    alternates: { types: { "application/json": `/store/${merchantId}/manifest.json` } },
  };
}

export default async function StorefrontPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  const merchant = await getMerchantStorefrontInfo(merchantId);
  if (!merchant) notFound();

  const [products, policy] = await Promise.all([getPublicCatalogue(merchantId), getMerchantPolicy(merchantId)]);

  return (
    <main className="max-w-5xl mx-auto px-4 md:px-8 py-10 space-y-10">
      <header className="border-b border-ink-line pb-6">
        <h1 className="text-[var(--t-h1)] font-[family-name:var(--font-display)] font-medium text-on-ink tracking-tight">
          {merchant.name}
        </h1>
        {!merchant.razorpayConnected && (
          <p className="text-sm text-escalate-bright bg-escalate-wash border border-escalate-line rounded-[var(--radius)] px-3 py-2 mt-3 inline-block">
            This store isn&apos;t accepting payments right now.
          </p>
        )}
        {/* A human sees exactly the same terms an agent reads via get_merchant_policy/the manifest — the cheapest check the structured data is right. */}
        <p className="text-xs text-on-ink-faint mt-3">{describeMerchantPolicy(policy)}</p>
      </header>

      {products.length === 0 ? (
        <p className="text-sm text-on-ink-dim">No products available right now.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {products.map((product) => {
            // The card shows the product's first active variant. Real
            // per-variant selection (size/colour pickers) is a Layer 5-7
            // gap, not built yet — see plans/layer-5-agent-readable-catalog.md.
            const variant = product.variants[0];
            const totalStock = product.variants.reduce((sum, v) => sum + v.stock, 0);
            const attributeEntries = Object.entries(variant.attributes);
            return (
              <div
                key={product.id}
                className="rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised p-4 flex flex-col transition-colors duration-[var(--dur-fast)] hover:border-on-ink-faint"
              >
                <h2 className="font-medium text-on-ink text-[var(--t-h4)]">{product.name}</h2>
                <p className="text-sm text-on-ink-dim flex-1 mt-1.5">{product.description}</p>
                <div className="mt-2 space-y-0.5">
                  <p className="text-xs text-on-ink-faint font-mono">SKU {variant.sku}</p>
                  {attributeEntries.length > 0 && (
                    <p className="text-xs text-on-ink-faint">
                      {attributeEntries.map(([k, v]) => `${k}: ${v}`).join(" · ")}
                    </p>
                  )}
                  {product.variants.length > 1 && (
                    <p className="text-xs text-on-ink-faint">{product.variants.length} variants available</p>
                  )}
                </div>
                <div className="flex items-center justify-between mt-4">
                  <span className="font-mono text-lg font-medium text-on-ink">{rupees(variant.pricePaise)}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      totalStock > 0 ? "bg-allow-wash text-allow-bright" : "bg-deny-wash text-deny-bright"
                    }`}
                  >
                    {totalStock > 0 ? `${totalStock} in stock` : "Out of stock"}
                  </span>
                </div>
                <div className="mt-3">
                  <BuyButton
                    merchantId={merchantId}
                    productId={product.id}
                    variantId={variant.id}
                    productName={product.name}
                    disabled={totalStock === 0 || !merchant.razorpayConnected}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {merchant.razorpayConnected && <ChatWidget merchantId={merchantId} />}
    </main>
  );
}
