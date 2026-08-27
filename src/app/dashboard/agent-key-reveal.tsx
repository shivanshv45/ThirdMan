"use client";

import { useActionState } from "react";
import { createAgentAction, rotateAgentKeyAction, type AgentKeyActionState } from "./actions";
import { Button, Input, Field } from "@/components/ui";

const initialState: AgentKeyActionState = null;

/**
 * Client component so the freshly generated raw key can be held in
 * component state and shown exactly once, then never again — the
 * server never re-sends it after this render. Everything else on the
 * dashboard stays a plain server-rendered form; this is split out only
 * because useActionState needs a Client Component.
 */
export function CreateAgentForm() {
  const [state, action, pending] = useActionState(createAgentAction, initialState);

  if (state?.rawKey) {
    return <RevealedKey name={state.agentName} rawKey={state.rawKey} />;
  }

  return (
    <form action={action} className="flex items-end gap-2">
      <div className="w-56">
        <Field label="Agent name">
          <Input name="name" required placeholder="e.g. Restock Bot" />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={pending} pendingLabel="Creating…">
        Create agent
      </Button>
      {state?.error && <p className="text-deny-bright text-xs">{state.error}</p>}
    </form>
  );
}

export function RotateKeyButton({ agentId }: { agentId: string }) {
  const [state, action, pending] = useActionState(rotateAgentKeyAction, initialState);

  if (state?.rawKey) {
    return <RevealedKey name={state.agentName} rawKey={state.rawKey} />;
  }

  return (
    <form action={action}>
      <input type="hidden" name="agentId" value={agentId} />
      <Button type="submit" size="sm" disabled={pending} pendingLabel="Rotating…">
        Rotate key
      </Button>
      {state?.error && <p className="text-deny-bright text-xs mt-1">{state.error}</p>}
    </form>
  );
}

function RevealedKey({ name, rawKey }: { name: string; rawKey: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-escalate-line bg-escalate-wash p-3 text-sm space-y-1.5">
      <p className="font-medium text-on-ink">New key for &quot;{name}&quot;</p>
      <p className="font-mono text-xs break-all bg-ink border border-ink-line rounded-[var(--radius)] px-2 py-1.5 text-on-ink">
        {rawKey}
      </p>
      <p className="text-xs text-escalate-bright">
        This will not be shown again. Copy it now and hand it to the agent out-of-band — reloading this page hides it for good.
      </p>
    </div>
  );
}
