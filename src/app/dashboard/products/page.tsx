import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionMerchant } from "@/lib/auth";
import { getProducts } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import { createProduct, updateProduct, archiveProduct, reactivateProduct } from "./actions";
import { StorefrontLink } from "./storefront-link";

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const { error } = await searchParams;
  const products = await getProducts(merchant.id);

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Products</h1>
        <p className="text-sm text-gray-500">
          Your catalogue. Agents can only buy products listed here, at the price and stock shown — never a price they name themselves.
        </p>
      </header>

      <div className="border rounded-lg p-4 flex items-center justify-between text-sm">
        <div>
          <p className="font-medium">Your storefront</p>
          <p className="text-gray-500">Real, human-payable checkout for active products.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/store/${merchant.id}`} target="_blank" className="text-blue-700 underline">
            Open store
          </Link>
          <StorefrontLink merchantId={merchant.id} />
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>
      )}

      <section className="border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Add a product</h2>
        <form action={createProduct} className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1 col-span-2">
            Name
            <input name="name" required className="border rounded px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            Description
            <textarea name="description" rows={2} className="border rounded px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1">
            Price (₹)
            <input name="priceRupees" type="number" step="0.01" min="0" required className="border rounded px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1">
            Cost (₹)
            <input name="costRupees" type="number" step="0.01" min="0" required className="border rounded px-3 py-2" />
            <span className="text-xs text-gray-400">Internal only — never shown to buyers.</span>
          </label>
          <label className="flex flex-col gap-1">
            Stock
            <input name="stock" type="number" step="1" min="0" required className="border rounded px-3 py-2" />
          </label>
          <div className="col-span-2">
            <button type="submit" className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
              Add product
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Catalogue {products.length > 0 && `(${products.length})`}</h2>
        {products.length === 0 ? (
          <p className="text-sm text-gray-500">No products yet — add one above.</p>
        ) : (
          <div className="space-y-4">
            {products.map((product) => (
              <div key={product.id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{product.name}</span>{" "}
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        product.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                      }`}
                    >
                      {product.status}
                    </span>
                  </div>
                  <form action={product.status === "active" ? archiveProduct : reactivateProduct}>
                    <input type="hidden" name="productId" value={product.id} />
                    <button type="submit" className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
                      {product.status === "active" ? "Archive" : "Reactivate"}
                    </button>
                  </form>
                </div>
                <p className="text-sm text-gray-500 mt-1">{product.description}</p>
                <div className="flex gap-4 text-sm text-gray-700 mt-2">
                  <span>{rupees(product.pricePaise)}</span>
                  <span>Stock {product.stock}</span>
                </div>

                <details className="mt-3">
                  <summary className="text-sm text-blue-700 cursor-pointer">Edit</summary>
                  <form action={updateProduct} className="grid grid-cols-2 gap-3 text-sm mt-3">
                    <input type="hidden" name="productId" value={product.id} />
                    <label className="flex flex-col gap-1 col-span-2">
                      Name
                      <input name="name" defaultValue={product.name} required className="border rounded px-3 py-2" />
                    </label>
                    <label className="flex flex-col gap-1 col-span-2">
                      Description
                      <textarea name="description" rows={2} defaultValue={product.description} className="border rounded px-3 py-2" />
                    </label>
                    <label className="flex flex-col gap-1">
                      Price (₹)
                      <input
                        name="priceRupees"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={(product.pricePaise / 100).toFixed(2)}
                        required
                        className="border rounded px-3 py-2"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      Cost (₹)
                      <input
                        name="costRupees"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={(product.costPaise / 100).toFixed(2)}
                        required
                        className="border rounded px-3 py-2"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      Stock
                      <input name="stock" type="number" step="1" min="0" defaultValue={product.stock} required className="border rounded px-3 py-2" />
                    </label>
                    <div className="col-span-2">
                      <button type="submit" className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm">
                        Save
                      </button>
                    </div>
                  </form>
                </details>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
