"use client";

import { useState, useTransition } from "react";
import { createShareLinkAction } from "./actions";
import { Surface, Button } from "@/components/ui";

/**
 * A merchant opting THIS ONE decision into being viewable outside the
 * dashboard — decision-share.ts's explicit, revocable, unguessable
 * token, never "anyone with the id" (see decision-share.ts's docstring).
 */
export function ShareLinkPanel({ decisionId }: { decisionId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    startTransition(async () => {
      const result = await createShareLinkAction(decisionId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setUrl(`${window.location.origin}/why/${decisionId}?share=${result.token}`);
    });
  }

  return (
    <Surface variant="raised" className="p-5">
      <div className="text-sm font-medium text-on-ink">Share this decision</div>
      <p className="text-xs text-on-ink-dim mt-1 max-w-[var(--measure)]">
        A decision is not public by default. Generating a link creates a specific, revocable token for this one decision only — nothing else in your dashboard becomes visible.
      </p>
      {!url ? (
        <Button type="button" variant="secondary" size="sm" onClick={handleCreate} disabled={isPending} className="mt-3">
          {isPending ? "Creating…" : "Create shareable link"}
        </Button>
      ) : (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <code className="text-xs font-mono bg-ink-overlay border border-ink-line rounded-[var(--radius)] px-2 py-1.5 break-all">{url}</code>
        </div>
      )}
      {error && <p className="text-xs text-deny-bright mt-2">{error}</p>}
    </Surface>
  );
}
