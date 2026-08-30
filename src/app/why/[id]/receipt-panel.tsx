"use client";

import { useState, useTransition } from "react";
import { issueReceiptForDecisionAction } from "./actions";
import { Surface, Button } from "@/components/ui";

/**
 * Layer 21-6's Refusal Receipt, offered from the natural place a human
 * reader already is: the same decision's human-readable explanation and
 * its machine-verifiable receipt, side by side (per
 * plans/layer-25-control-surfaces.md's L25-4). Only offered to the
 * merchant themselves, not on a public share view — a receipt is signed
 * evidence a merchant hands out deliberately, not something baked into
 * a link anyone could pass around.
 */
export function ReceiptPanel({ decisionId, merchantId, isMerchantSession }: { decisionId: string; merchantId: string; isMerchantSession: boolean }) {
  const [receipt, setReceipt] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!isMerchantSession) return null;

  function handleIssue() {
    startTransition(async () => {
      const result = await issueReceiptForDecisionAction(merchantId, decisionId);
      if (!result.receipt) {
        setUnavailable(true);
        return;
      }
      setReceipt(result.receipt);
    });
  }

  return (
    <Surface variant="raised" className="p-5">
      <div className="text-sm font-medium text-on-ink">Refusal Receipt</div>
      <p className="text-xs text-on-ink-dim mt-1 max-w-[var(--measure)]">
        A signed JWT over this exact decision, verifiable against this merchant&rsquo;s own published public key — machine-checkable proof, not just prose.
      </p>
      {!receipt && !unavailable && (
        <Button type="button" variant="secondary" size="sm" onClick={handleIssue} disabled={isPending} className="mt-3">
          {isPending ? "Signing…" : "Issue a receipt for this decision"}
        </Button>
      )}
      {receipt && (
        <code className="block mt-3 text-xs font-mono bg-ink-overlay border border-ink-line rounded-[var(--radius)] px-2 py-1.5 break-all max-h-32 overflow-y-auto">
          {receipt}
        </code>
      )}
      {unavailable && <p className="text-xs text-on-ink-faint mt-2">No receipt could be issued for this decision.</p>}
    </Surface>
  );
}
