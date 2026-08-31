"use client";

import { SectionChatBar } from "@/components/ui";
import { draftProductsChatAction, confirmProductsChatAction } from "./actions";
import type { ProductsProposal } from "@/lib/section-chat/products-schema";

export function ProductsChatBar() {
  return (
    <SectionChatBar<ProductsProposal>
      placeholder='Try "add a 500g dark roast bag for 450 rupees, 30 in stock"'
      onDraft={draftProductsChatAction}
      onConfirm={confirmProductsChatAction}
      renderProposal={(proposal) =>
        proposal.kind === "create_product" ? (
          <div>
            <p className="font-medium">{proposal.name}</p>
            <p>
              ₹{proposal.priceRupees} · cost ₹{proposal.costRupees} · {proposal.stock} in stock
              {proposal.sku ? ` · SKU ${proposal.sku}` : ""}
            </p>
          </div>
        ) : proposal.kind === "no_action" ? (
          <p>{proposal.summary}</p>
        ) : null
      }
    />
  );
}
