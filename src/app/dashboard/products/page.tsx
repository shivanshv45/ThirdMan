import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionMerchant } from "@/lib/auth";
import { getProducts } from "@/lib/dashboard";
import { formatPaise as rupees } from "@/lib/money";
import {
  createProduct,
  updateProduct,
  archiveProduct,
  reactivateProduct,
  addVariant,
  updateVariant,
  archiveVariant,
  reactivateVariant,
} from "./actions";
import { StorefrontLink } from "./storefront-link";
import { ImportCatalogue } from "./import-catalogue";
import { PageHeader, Surface, Button, Field, Input, EmptyState, DetailsToggle } from "@/components/ui";

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
    <div className="space-y-8">
      <PageHeader
        title="Products"
        description="Your catalogue. Agents can only buy products listed here, at the price and stock shown — never a price they name themselves."
      />

      <Surface variant="raised" className="p-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="font-medium text-on-ink text-sm">Your storefront</p>
          <p className="text-on-ink-dim text-sm">Real, human-payable checkout for active products.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/store/${merchant.id}`}
            target="_blank"
            className="text-sm text-accent hover:text-accent-bright underline underline-offset-2"
          >
            Open store
          </Link>
          <StorefrontLink merchantId={merchant.id} />
        </div>
      </Surface>

      {error && (
        <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          {error}
        </p>
      )}

      <ImportCatalogue />

      <Surface variant="raised" className="p-5">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-3">Add a product</h2>
        <form action={createProduct} className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label="Name">
              <Input name="name" required />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="Description">
              <textarea
                name="description"
                rows={2}
                className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="SKU" help="Optional — generated if left blank">
              <Input name="sku" />
            </Field>
          </div>
          <Field label="Price (₹)">
            <Input name="priceRupees" type="number" step="0.01" min="0" required />
          </Field>
          <Field label="Cost (₹)" help="Internal only — never shown to buyers">
            <Input name="costRupees" type="number" step="0.01" min="0" required />
          </Field>
          <Field label="Stock">
            <Input name="stock" type="number" step="1" min="0" required />
          </Field>
          <div className="col-span-2">
            <Button type="submit" variant="primary" pendingLabel="Adding…">
              Add product
            </Button>
          </div>
        </form>
      </Surface>

      <section>
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-3">
          Catalogue {products.length > 0 && <span className="text-on-ink-faint font-mono text-base">({products.length})</span>}
        </h2>
        {products.length === 0 ? (
          <EmptyState title="No products yet" description="Add one above, or import a CSV." />
        ) : (
          <div className="space-y-4">
            {products.map((product) => {
              const primaryVariant = product.variants[0];
              const hasMultipleVariants = product.variants.length > 1;
              return (
                <Surface key={product.id} variant="raised" className="p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-on-ink">{product.name}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          product.status === "active"
                            ? "bg-allow-wash text-allow-bright"
                            : "bg-ink-overlay text-on-ink-faint"
                        }`}
                      >
                        {product.status}
                      </span>
                      {hasMultipleVariants && (
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-accent-wash text-accent-bright">
                          {product.variants.length} variants
                        </span>
                      )}
                    </div>
                    <form action={product.status === "active" ? archiveProduct : reactivateProduct}>
                      <input type="hidden" name="productId" value={product.id} />
                      <Button type="submit" size="sm" variant="secondary">
                        {product.status === "active" ? "Archive" : "Reactivate"}
                      </Button>
                    </form>
                  </div>
                  <p className="text-sm text-on-ink-dim mt-1">{product.description}</p>
                  {primaryVariant && !hasMultipleVariants && (
                    <div className="flex gap-4 text-sm mt-2 font-mono tabular-nums">
                      <span className="text-on-ink">{rupees(primaryVariant.pricePaise)}</span>
                      <span className="text-on-ink-dim">Stock {primaryVariant.stock}</span>
                      <span className="text-on-ink-faint">SKU {primaryVariant.sku}</span>
                    </div>
                  )}

                  {hasMultipleVariants && (
                    <div className="mt-3 space-y-2">
                      {product.variants.map((variant) => (
                        <div key={variant.id} className="rounded-[var(--radius)] border border-ink-line bg-ink-overlay/50 p-3">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex gap-3 text-sm font-mono tabular-nums items-center">
                              <span className="text-on-ink">{rupees(variant.pricePaise)}</span>
                              <span className="text-on-ink-dim">Stock {variant.stock}</span>
                              <span className="text-on-ink-faint">SKU {variant.sku}</span>
                              {Object.entries(variant.attributes as Record<string, string>).map(([k, v]) => (
                                <span key={k} className="text-xs px-1.5 py-0.5 rounded bg-ink-line text-on-ink-dim">
                                  {k}: {v}
                                </span>
                              ))}
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  variant.status === "active" ? "bg-allow-wash text-allow-bright" : "bg-ink-line text-on-ink-faint"
                                }`}
                              >
                                {variant.status}
                              </span>
                            </div>
                            <form action={variant.status === "active" ? archiveVariant : reactivateVariant}>
                              <input type="hidden" name="variantId" value={variant.id} />
                              <Button type="submit" size="sm" variant="secondary">
                                {variant.status === "active" ? "Archive" : "Reactivate"}
                              </Button>
                            </form>
                          </div>
                          <div className="mt-2">
                            <DetailsToggle summary="Edit variant">
                              <VariantEditForm variant={variant} />
                            </DetailsToggle>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {!hasMultipleVariants && primaryVariant && (
                    <div className="mt-3">
                      <DetailsToggle summary="Edit">
                        <form action={updateProduct} className="grid grid-cols-2 gap-3 mt-2 font-sans">
                          <input type="hidden" name="productId" value={product.id} />
                          <input type="hidden" name="variantId" value={primaryVariant.id} />
                          <div className="col-span-2">
                            <Field label="Name">
                              <Input name="name" defaultValue={product.name} required />
                            </Field>
                          </div>
                          <div className="col-span-2">
                            <Field label="Description">
                              <textarea
                                name="description"
                                rows={2}
                                defaultValue={product.description}
                                className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
                              />
                            </Field>
                          </div>
                          <div className="col-span-2">
                            <Field label="SKU">
                              <Input name="sku" defaultValue={primaryVariant.sku} required />
                            </Field>
                          </div>
                          <Field label="Price (₹)">
                            <Input
                              name="priceRupees"
                              type="number"
                              step="0.01"
                              min="0"
                              defaultValue={(primaryVariant.pricePaise / 100).toFixed(2)}
                              required
                            />
                          </Field>
                          <Field label="Cost (₹)">
                            <Input
                              name="costRupees"
                              type="number"
                              step="0.01"
                              min="0"
                              defaultValue={(primaryVariant.costPaise / 100).toFixed(2)}
                              required
                            />
                          </Field>
                          <Field label="Stock">
                            <Input name="stock" type="number" step="1" min="0" defaultValue={primaryVariant.stock} required />
                          </Field>
                          <div className="col-span-2">
                            <Button type="submit" variant="primary" size="sm" pendingLabel="Saving…">
                              Save
                            </Button>
                          </div>
                        </form>
                      </DetailsToggle>
                    </div>
                  )}

                  <div className="mt-3">
                    <DetailsToggle summary="Add a variant (size, colour, ...)">
                      <form action={addVariant} className="grid grid-cols-2 gap-3 mt-2 font-sans">
                        <input type="hidden" name="productId" value={product.id} />
                        <Field label="SKU" help="Optional — generated if left blank">
                          <Input name="sku" />
                        </Field>
                        <div />
                        <Field label="Attribute name" help="e.g. size">
                          <Input name="attributeKey" placeholder="size" />
                        </Field>
                        <Field label="Attribute value" help="e.g. 1kg">
                          <Input name="attributeValue" placeholder="1kg" />
                        </Field>
                        <Field label="Price (₹)">
                          <Input name="priceRupees" type="number" step="0.01" min="0" required />
                        </Field>
                        <Field label="Cost (₹)" help="Internal only — never shown to buyers">
                          <Input name="costRupees" type="number" step="0.01" min="0" required />
                        </Field>
                        <Field label="Stock">
                          <Input name="stock" type="number" step="1" min="0" required />
                        </Field>
                        <div className="col-span-2">
                          <Button type="submit" variant="secondary" size="sm" pendingLabel="Adding…">
                            Add variant
                          </Button>
                        </div>
                      </form>
                    </DetailsToggle>
                  </div>
                </Surface>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function VariantEditForm({ variant }: { variant: { id: string; sku: string; pricePaise: number; costPaise: number; stock: number; attributes: unknown } }) {
  const attrs = variant.attributes as Record<string, string>;
  const [firstKey, firstValue] = Object.entries(attrs)[0] ?? ["", ""];
  return (
    <form action={updateVariant} className="grid grid-cols-2 gap-3 mt-2 font-sans">
      <input type="hidden" name="variantId" value={variant.id} />
      <div className="col-span-2">
        <Field label="SKU">
          <Input name="sku" defaultValue={variant.sku} required />
        </Field>
      </div>
      <Field label="Attribute name">
        <Input name="attributeKey" defaultValue={firstKey} placeholder="size" />
      </Field>
      <Field label="Attribute value">
        <Input name="attributeValue" defaultValue={firstValue} placeholder="1kg" />
      </Field>
      <Field label="Price (₹)">
        <Input name="priceRupees" type="number" step="0.01" min="0" defaultValue={(variant.pricePaise / 100).toFixed(2)} required />
      </Field>
      <Field label="Cost (₹)">
        <Input name="costRupees" type="number" step="0.01" min="0" defaultValue={(variant.costPaise / 100).toFixed(2)} required />
      </Field>
      <Field label="Stock">
        <Input name="stock" type="number" step="1" min="0" defaultValue={variant.stock} required />
      </Field>
      <div className="col-span-2">
        <Button type="submit" variant="primary" size="sm" pendingLabel="Saving…">
          Save
        </Button>
      </div>
    </form>
  );
}
