"use client";

import { useEffect, useState } from "react";

const SESSION_STORAGE_KEY = "thirdman_chat_session"; // same key chat-widget.tsx uses, so a returning buyer's coin balance and chat session are the same identity

function getOrCreateSessionToken(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

interface Tier {
  id: string;
  displayName: string;
  coinsPerRequest: number;
}

interface StateResponse {
  balance: number;
  enabled: boolean;
  tiers: Tier[];
}

interface RedeemResponse {
  decision: "allow" | "deny";
  reason: string;
  responseText?: string;
  providerServed?: string;
  coinsSpent?: number;
}

/**
 * Layer 11-8's buyer-facing surface: spend real reward coins on a real
 * AI response from a real, merchant-configured Groq model tier. No
 * sample balance, no placeholder tier list, no fabricated conversation
 * — every number here is read live from the server on mount, matching
 * the EmptyState no-mocks discipline every other dashboard/storefront
 * surface in this codebase already follows.
 */
export function AiCreditsPanel({ merchantId }: { merchantId: string }) {
  // Lazy initializer, not an effect — the token itself is a pure
  // read/create against sessionStorage with no dependency on the
  // fetch below, so it doesn't belong inside the effect that
  // synchronizes with the server.
  const [sessionToken] = useState<string>(() => getOrCreateSessionToken());
  const [state, setState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTierId, setSelectedTierId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [result, setResult] = useState<RedeemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ai-credits/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchantId, sessionToken }),
    })
      .then((res) => res.json())
      .then((data: StateResponse) => {
        setState(data);
        if (data.tiers.length > 0) setSelectedTierId(data.tiers[0].id);
      })
      .catch(() => setError("Could not load your balance right now."))
      .finally(() => setLoading(false));
  }, [merchantId, sessionToken]);

  async function handleRedeem() {
    if (!selectedTierId || !prompt.trim()) return;
    setRedeeming(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/ai-credits/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId, sessionToken, tierId: selectedTierId, prompt: prompt.trim() }),
      });
      const data: RedeemResponse = await res.json();
      setResult(data);
      if (data.decision === "allow" && state) {
        setState({ ...state, balance: state.balance - (data.coinsSpent ?? 0) });
      }
    } catch {
      setError("Something went wrong sending that — try again.");
    } finally {
      setRedeeming(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-on-ink-faint">Loading your balance…</p>;
  }

  if (!state?.enabled) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-ink-line px-6 py-10 text-center">
        <p className="text-sm font-medium text-on-ink">Rewards aren&apos;t enabled here</p>
        <p className="mt-1 text-sm text-on-ink-dim">This merchant hasn&apos;t turned on reward coins yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between border-b border-ink-line pb-4">
        <span className="text-sm text-on-ink-dim">Your balance</span>
        <span className="text-2xl font-mono font-medium text-on-ink">{state.balance} coins</span>
      </div>

      {state.tiers.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-ink-line px-6 py-10 text-center">
          <p className="text-sm font-medium text-on-ink">No AI tiers available yet</p>
          <p className="mt-1 text-sm text-on-ink-dim">This merchant hasn&apos;t set up any AI-credit tiers.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-sm text-on-ink-dim font-medium">Model</span>
            <select
              value={selectedTierId}
              onChange={(e) => setSelectedTierId(e.target.value)}
              className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
            >
              {state.tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.displayName} — {tier.coinsPerRequest} coins
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <span className="text-sm text-on-ink-dim font-medium">Your message</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Ask anything…"
              className="w-full rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink placeholder:text-on-ink-faint outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
            />
          </div>

          <button
            type="button"
            onClick={handleRedeem}
            disabled={redeeming || !prompt.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium text-sm px-3.5 py-2 bg-accent text-accent-ink hover:bg-accent-bright transition-colors duration-[var(--dur-fast)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {redeeming ? "Sending…" : "Spend coins"}
          </button>

          {error && <p className="text-sm text-deny-bright">{error}</p>}

          {result && (
            <div
              className={`rounded-[var(--radius)] border px-4 py-3 text-sm ${
                result.decision === "allow" ? "border-allow-line bg-allow-wash text-on-ink" : "border-deny-line bg-deny-wash text-deny-bright"
              }`}
            >
              {result.decision === "allow" ? (
                <>
                  <p className="whitespace-pre-wrap">{result.responseText}</p>
                  <p className="mt-2 text-xs text-on-ink-faint">
                    {result.coinsSpent} coins spent · served by {result.providerServed}
                  </p>
                </>
              ) : (
                <p>{result.reason}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
