"use client";

import { useState } from "react";

/** Copies the storefront URL to the clipboard. Split into its own client component since window/navigator aren't available in a server component. */
export function StorefrontLink({ merchantId }: { merchantId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/store/${merchantId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied or unavailable — the "Open store" link next to this button still works.
    }
  }

  return (
    <button type="button" onClick={copy} className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}
