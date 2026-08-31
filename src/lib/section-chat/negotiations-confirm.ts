import { eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import * as mutations from "@/lib/dashboard-mutations";
import { negotiationsProposalSchema, type NegotiationsProposal } from "./negotiations-schema";

/**
 * The Negotiations section chat bar's write-facing half. Resolves the
 * merchant-named SKU to a real variant it owns, then calls the exact
 * same mutations.setVariantNegotiationFloor the manual form's
 * setNegotiationFloor Server Action calls. No import of the LLM
 * wrapper or negotiations-draft.ts, see
 * section-chat/negotiations.isolation.test.ts.
 */

export async function confirmNegotiationsAction(
  merchantId: string,
  proposal: NegotiationsProposal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = negotiationsProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: "That proposal is no longer valid. Draft it again." };
  }

  try {
    if (parsed.data.kind === "set_floor") {
      const { sku, floorPriceRupees, belowCostAcknowledged } = parsed.data;

      const [variant] = await db
        .select({ id: schema.productVariants.id })
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.merchantId, merchantId), eq(schema.productVariants.sku, sku)));

      if (!variant) {
        return { ok: false, reason: `No variant with SKU "${sku}" found. Check the SKU and try again.` };
      }

      await mutations.setVariantNegotiationFloor({
        merchantId,
        variantId: variant.id,
        floorPriceRupees,
        belowCostAcknowledged,
      });
      return { ok: true };
    }

    return { ok: false, reason: "Nothing to confirm." };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not run that action." };
  }
}
