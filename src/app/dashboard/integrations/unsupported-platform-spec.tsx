"use client";

import { useActionState, useState } from "react";
import { generateUnsupportedPlatformSpecAction, type UnsupportedPlatformSpecState } from "./actions";
import { Button } from "@/components/ui";

const initialState: UnsupportedPlatformSpecState = null;

/** L24-6: a spec for a developer to review, not an instruction for an AI to execute unsupervised — see the module this calls for why. */
export function UnsupportedPlatformSpec() {
  const [state, action, pending] = useActionState(generateUnsupportedPlatformSpecAction, initialState);
  const [copied, setCopied] = useState(false);

  async function copy(content: string) {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <form action={action} className="space-y-3">
      <Button type="submit" variant="secondary" disabled={pending} pendingLabel="Generating…">
        Generate the spec
      </Button>
      {state && "content" in state && state.content && (
        <div className="space-y-2">
          <pre className="font-mono text-xs bg-ink border border-ink-line rounded-[var(--radius)] px-3 py-2.5 overflow-x-auto text-on-ink whitespace-pre-wrap max-h-96 overflow-y-auto">
            {state.content}
          </pre>
          <button
            type="button"
            onClick={() => copy(state.content!)}
            className="text-xs px-2.5 py-1.5 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)]"
          >
            {copied ? "Copied" : "Copy full spec"}
          </button>
        </div>
      )}
      {state && "error" in state && <p className="text-sm text-deny-bright">{state.error}</p>}
    </form>
  );
}
