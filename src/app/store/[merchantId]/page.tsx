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
  return {
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
    <main className="max-w-4xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{merchant.name}</h1>
        {!merchant.razorpayConnected && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-2">
            This store isn&apos;t accepting payments right now.
          </p>
        )}
        {/* A human sees exactly the same terms an agent reads via get_merchant_policy/the manifest — the cheapest check the structured data is right. */}
        <p className="text-xs text-gray-400 mt-2">{describeMerchantPolicy(policy)}</p>
      </header>

      {products.length === 0 ? (
        <p className="text-sm text-gray-500">No products available right now.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {products.map((product) => {
            // The card shows the product's first active variant. Real
            // per-variant selection (size/colour pickers) is a Layer 5-7
            // gap, not built yet — see plans/layer-5-agent-readable-catalog.md.
            const variant = product.variants[0];
            const totalStock = product.variants.reduce((sum, v) => sum + v.stock, 0);
            const attributeEntries = Object.entries(variant.attributes);
            return (
              <div key={product.id} className="border rounded-lg p-4 flex flex-col">
                <h2 className="font-medium">{product.name}</h2>
                <p className="text-sm text-gray-500 flex-1 mt-1">{product.description}</p>
                <p className="text-xs text-gray-400 mt-1">SKU {variant.sku}</p>
                {attributeEntries.length > 0 && (
                  <p className="text-xs text-gray-400">
                    {attributeEntries.map(([k, v]) => `${k}: ${v}`).join(" · ")}
                  </p>
                )}
                {product.variants.length > 1 && (
                  <p className="text-xs text-gray-400 mt-1">{product.variants.length} variants available</p>
                )}
                <div className="flex items-center justify-between mt-3">
                  <span className="font-semibold">{rupees(variant.pricePaise)}</span>
                  <span className="text-xs text-gray-400">{totalStock > 0 ? `${totalStock} in stock` : "Out of stock"}</span>
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
