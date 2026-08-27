"use client";

import { useState } from "react";
import { suggestDescription } from "./actions";

/**
 * Shows a draft description the merchant can copy into a product's edit
 * form — never auto-applied. The model proposes; only the merchant's own
 * save action (on /dashboard/products) writes it.
 */
export function SuggestDescription({ productId, productName }: { productId: string; productName: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [text, setText] = useState<string | null>(null);

  async function handleSuggest() {
    setStatus("loading");
    const result = await suggestDescription(productId);
    if (result.suggestion) {
      setText(result.suggestion);
      setStatus("done");
    } else {
      setText(result.error ?? "Could not generate a suggestion.");
      setStatus("error");
    }
  }

  if (status === "idle") {
    return (
      <button
        onClick={handleSuggest}
        className="text-xs text-accent hover:text-accent-bright underline underline-offset-2 transition-colors"
      >
        Suggest a description for &quot;{productName}&quot;
      </button>
    );
  }

  if (status === "loading") {
    return (
      <p className="text-xs text-on-ink-faint flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
        Generating a draft…
      </p>
    );
  }

  return (
    <div className="text-xs bg-ink-overlay border border-ink-line-soft rounded-[var(--radius)] p-2.5 mt-1">
      <p className={status === "error" ? "text-deny-bright" : "text-on-ink"}>{text}</p>
      {status === "done" && (
        <p className="text-on-ink-faint mt-1.5">
          Draft only — copy it into the product&apos;s edit form on the Products page to save it.
        </p>
      )}
    </div>
  );
}
