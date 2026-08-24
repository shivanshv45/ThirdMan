"use client";

import { useActionState } from "react";
import { createAgentAction, rotateAgentKeyAction, type AgentKeyActionState } from "./actions";

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
    <form action={action} className="flex items-end gap-2 text-sm">
      <label className="flex flex-col">
        Agent name
        <input name="name" required className="border rounded px-2 py-1" placeholder="e.g. Restock Bot" />
      </label>
      <button type="submit" disabled={pending} className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
        {pending ? "Creating…" : "Create agent"}
      </button>
      {state?.error && <p className="text-red-600 text-xs ml-2">{state.error}</p>}
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
      <button type="submit" disabled={pending} className="text-sm px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-50">
        {pending ? "Rotating…" : "Rotate key"}
      </button>
      {state?.error && <p className="text-red-600 text-xs mt-1">{state.error}</p>}
    </form>
  );
}

function RevealedKey({ name, rawKey }: { name: string; rawKey: string }) {
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 text-sm space-y-1">
      <p className="font-medium">New key for &quot;{name}&quot;</p>
      <p className="font-mono text-xs break-all bg-white border rounded px-2 py-1">{rawKey}</p>
      <p className="text-xs text-amber-800">
        This will not be shown again. Copy it now and hand it to the agent out-of-band — reloading this page hides it for good.
      </p>
    </div>
  );
}
