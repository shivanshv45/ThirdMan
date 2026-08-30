"use client";

import { useActionState } from "react";
import { generateWooCommercePluginAction, type WooCommercePluginState } from "./actions";
import { Button } from "@/components/ui";

const initialState: WooCommercePluginState = null;

/**
 * L24-4: the merchant clicks once, gets a real .php file with their
 * merchant id and publishable key already baked in — nothing typed. The
 * browser-side download (Blob + a synthetic click) is the only way to
 * hand a generated file to the merchant from a Server Action's return
 * value without a dedicated file-serving route.
 */
export function WooCommerceDownload() {
  const [state, action, pending] = useActionState(generateWooCommercePluginAction, initialState);

  function download(filename: string, content: string) {
    const blob = new Blob([content], { type: "application/x-php" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <form action={action}>
      <Button type="submit" variant="primary" disabled={pending} pendingLabel="Generating…">
        Generate my plugin file
      </Button>
      {state && "content" in state && state.content && (
        <PluginReady filename={state.filename!} content={state.content} onDownload={download} />
      )}
      {state && "error" in state && <p className="mt-2 text-sm text-deny-bright">{state.error}</p>}
    </form>
  );
}

function PluginReady({ filename, content, onDownload }: { filename: string; content: string; onDownload: (filename: string, content: string) => void }) {
  return (
    <div className="mt-3 rounded-[var(--radius-lg)] border border-allow-line bg-allow-wash p-3 text-sm space-y-2">
      <p className="text-on-ink">
        <span className="font-mono text-xs">{filename}</span> is ready — {Math.round(content.length / 1024)}KB, pre-configured for this account.
      </p>
      <button
        type="button"
        onClick={() => onDownload(filename, content)}
        className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium text-sm px-3.5 py-2 bg-accent text-accent-ink hover:bg-accent-bright transition-colors duration-[var(--dur-fast)]"
      >
        Download {filename}
      </button>
      <p className="text-xs text-on-ink-faint">Upload it in WordPress admin → Plugins → Add New → Upload Plugin, then click Activate.</p>
    </div>
  );
}
