"use client";

import { useActionState } from "react";
import { generateCliLinkTokenAction, type CliLinkActionState } from "./actions";
import { Button } from "@/components/ui";

const initialState: CliLinkActionState = null;

/** Same "shown once" pattern as embed's secret-reveal.tsx — this token is a real, if short-lived, credential. */
export function GenerateCliLinkToken() {
  const [state, action, pending] = useActionState(generateCliLinkTokenAction, initialState);

  if (state && "token" in state) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-escalate-line bg-escalate-wash p-3 text-sm space-y-1.5">
        <p className="font-medium text-on-ink">Paste this into your terminal</p>
        <p className="font-mono text-xs break-all bg-ink border border-ink-line rounded-[var(--radius)] px-2 py-1.5 text-on-ink">
          {state.token}
        </p>
        <p className="text-xs text-escalate-bright">
          Valid for 10 minutes and usable once — run <span className="font-mono">npx thirdman init</span> and paste it when asked.
        </p>
      </div>
    );
  }

  return (
    <form action={action}>
      <Button type="submit" variant="primary" disabled={pending} pendingLabel="Generating…">
        Generate a CLI link token
      </Button>
      {state && "error" in state && <p className="text-deny-bright text-xs mt-1">{state.error}</p>}
    </form>
  );
}
