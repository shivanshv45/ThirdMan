import { notFound } from "next/navigation";
import { getMerchantStorefrontInfo, getPublicCatalogue } from "@/lib/storefront-catalogue";
import { formatPaise as rupees } from "@/lib/money";
import { BuyButton } from "./buy-button";
import { ChatWidget } from "./chat-widget";

export default async function StorefrontPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  const merchant = await getMerchantStorefrontInfo(merchantId);
  if (!merchant) notFound();

  const products = await getPublicCatalogue(merchantId);

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{merchant.name}</h1>
        {!merchant.razorpayConnected && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-2">
            This store isn&apos;t accepting payments right now.
          </p>
        )}
      </header>

      {products.length === 0 ? (
        <p className="text-sm text-gray-500">No products available right now.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {products.map((product) => (
            <div key={product.id} className="border rounded-lg p-4 flex flex-col">
              <h2 className="font-medium">{product.name}</h2>
              <p className="text-sm text-gray-500 flex-1 mt-1">{product.description}</p>
              <div className="flex items-center justify-between mt-3">
                <span className="font-semibold">{rupees(product.pricePaise)}</span>
                <span className="text-xs text-gray-400">{product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}</span>
              </div>
              <div className="mt-3">
                <BuyButton
                  merchantId={merchantId}
                  productId={product.id}
                  productName={product.name}
                  disabled={product.stock === 0 || !merchant.razorpayConnected}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {merchant.razorpayConnected && <ChatWidget merchantId={merchantId} />}
    </main>
  );
}
