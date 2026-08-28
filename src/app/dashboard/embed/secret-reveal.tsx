"use client";

import { useActionState } from "react";
import { rotateEmbedKeyAction, registerWebhookAction, type RotateEmbedKeyState, type RegisterWebhookState } from "./actions";
import { Button, Input, Field } from "@/components/ui";

/**
 * The "shown once" pattern agent-key-reveal.tsx established, applied to
 * two different secrets here: rotating the embed publishable key (not
 * actually secret, but rotating breaks every live snippet, so the same
 * "look at this and go update your site" moment applies) and
 * registering a webhook (genuinely secret — signs every delivery).
 */

const initialRotateState: RotateEmbedKeyState = null;
const initialRegisterState: RegisterWebhookState = null;

export function RotateEmbedKeyButton({ appOrigin }: { appOrigin: string }) {
  const [state, action, pending] = useActionState(rotateEmbedKeyAction, initialRotateState);

  if (state && "rawKey" in state) {
    return <RevealedSnippet appOrigin={appOrigin} publishableKey={state.rawKey} />;
  }

  return (
    <form action={action}>
      <Button type="submit" variant="destructive" size="sm" disabled={pending} pendingLabel="Rotating…">
        Rotate embed key
      </Button>
      {state && "error" in state && <p className="text-deny-bright text-xs mt-1">{state.error}</p>}
    </form>
  );
}

function RevealedSnippet({ appOrigin, publishableKey }: { appOrigin: string; publishableKey: string }) {
  const snippet = `<script async src="${appOrigin}/api/embed/v1.js" data-embed-key="${publishableKey}"></script>`;
  return (
    <div className="rounded-[var(--radius-lg)] border border-escalate-line bg-escalate-wash p-3 text-sm space-y-1.5">
      <p className="font-medium text-on-ink">New embed key generated</p>
      <p className="font-mono text-xs break-all bg-ink border border-ink-line rounded-[var(--radius)] px-2 py-1.5 text-on-ink">
        {snippet}
      </p>
      <p className="text-xs text-escalate-bright">
        Every site still running the old snippet has stopped working — update them to this one.
      </p>
    </div>
  );
}

export function RegisterWebhookForm() {
  const [state, action, pending] = useActionState(registerWebhookAction, initialRegisterState);

  if (state && "rawSecret" in state) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-escalate-line bg-escalate-wash p-3 text-sm space-y-1.5">
        <p className="font-medium text-on-ink">Webhook registered</p>
        <p className="font-mono text-xs break-all bg-ink border border-ink-line rounded-[var(--radius)] px-2 py-1.5 text-on-ink">
          {state.rawSecret}
        </p>
        <p className="text-xs text-escalate-bright">
          This signing secret will not be shown again. Copy it now — you&apos;ll need it to verify delivery signatures. Unlike your embed key, this one is genuinely secret.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 max-w-md">
      <Field label="Your endpoint URL">
        <Input name="url" type="url" placeholder="https://yourserver.example.com/webhooks/thirdman" required />
      </Field>
      <fieldset className="space-y-1.5">
        <legend className="text-sm text-on-ink-dim font-medium mb-1">Events</legend>
        {[
          { value: "order.paid", label: "order.paid — a purchase was captured" },
          { value: "order.held", label: "order.held — an escrow hold was authorised" },
          { value: "order.refunded", label: "order.refunded — a purchase was refunded" },
          { value: "stock.changed", label: "stock.changed — a variant's stock changed" },
        ].map((e) => (
          <label key={e.value} className="flex items-center gap-2 text-sm text-on-ink-dim">
            <input type="checkbox" name="events" value={e.value} defaultChecked={e.value === "order.paid"} className="accent-accent" />
            {e.label}
          </label>
        ))}
      </fieldset>
      <Button type="submit" variant="primary" disabled={pending} pendingLabel="Registering…">
        Register webhook
      </Button>
      {state && "error" in state && <p className="text-deny-bright text-xs">{state.error}</p>}
    </form>
  );
}
