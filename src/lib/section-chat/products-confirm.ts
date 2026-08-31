import * as mutations from "@/lib/dashboard-mutations";
import { productsProposalSchema, type ProductsProposal } from "./products-schema";

/**
 * The Products section chat bar's write-facing half. Calls the exact
 * same mutations.createProduct the manual form's createProduct Server
 * Action calls. No import of the LLM wrapper or products-draft.ts, see
 * section-chat/products.isolation.test.ts.
 */

export async function confirmProductsAction(
  merchantId: string,
  proposal: ProductsProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = productsProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "create_product") {
      const { name, description, priceRupees, costRupees, stock, sku } = parsed.data;
      await mutations.createProduct({ merchantId, name, description, priceRupees, costRupees, stock, sku });
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not run that action." };
  }
}
