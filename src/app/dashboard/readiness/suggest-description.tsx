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
      <button onClick={handleSuggest} className="text-xs text-blue-700 underline">
        Suggest a description for &quot;{productName}&quot;
      </button>
    );
  }

  if (status === "loading") {
    return <p className="text-xs text-gray-400">Generating a draft…</p>;
  }

  return (
    <div className="text-xs bg-gray-50 border rounded p-2 mt-1">
      <p className={status === "error" ? "text-red-700" : "text-gray-700"}>{text}</p>
      {status === "done" && <p className="text-gray-400 mt-1">Draft only — copy it into the product&apos;s edit form on the Products page to save it.</p>}
    </div>
  );
}
