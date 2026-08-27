"use client";

import { useState, useTransition } from "react";
import { formatPaise } from "@/lib/money";
import { getTranscript, type TranscriptTurn } from "./actions";
import type { NegotiationRow } from "@/lib/dashboard";
import { DecisionBadge, type Decision } from "@/components/ui";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatTime(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusToDecision(status: string): Decision {
  if (status === "agreed" || status === "redeemed") return "allow";
  if (status === "refused_turns_exhausted") return "deny";
  if (status === "open") return "escalate";
  return "n/a";
}

export function NegotiationList({ negotiations, statusLabels }: { negotiations: NegotiationRow[]; statusLabels: Record<string, string> }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptTurn[]>>({});
  const [isPending, startTransition] = useTransition();

  function toggle(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!transcripts[id]) {
      startTransition(async () => {
        const turns = await getTranscript(id);
        setTranscripts((prev) => ({ ...prev, [id]: turns }));
      });
    }
  }

  return (
    <ul className="space-y-2">
      {negotiations.map((n) => {
        const expanded = expandedId === n.id;
        const loading = isPending && expanded && !transcripts[n.id];

        return (
          <li key={n.id} className="rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised px-4 py-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-sm">
                <DecisionBadge decision={statusToDecision(n.status)} label={statusLabels[n.status] ?? n.status} />
                <span className="font-medium text-on-ink font-mono">
                  {n.variantSku} ×{n.quantity}
                </span>
              </div>
              <span className="text-xs text-on-ink-faint font-mono">{formatDate(n.resolvedAt ?? n.createdAt)}</span>
            </div>
            <p className="mt-1.5 text-sm text-on-ink-dim font-mono">
              Catalogue {formatPaise(n.catalogueUnitPricePaise)}/unit, floor {formatPaise(n.floorUnitPricePaise)}/unit
              {n.agreedUnitPricePaise !== null && <> — agreed at {formatPaise(n.agreedUnitPricePaise)}/unit</>}
              {" "}
              <span className="text-on-ink-faint">
                ({n.buyerTurnCount} counter-offer{n.buyerTurnCount === 1 ? "" : "s"})
              </span>
            </p>
            <button type="button" onClick={() => toggle(n.id)} className="text-xs text-accent hover:text-accent-bright mt-1.5 transition-colors">
              {expanded ? "Hide transcript" : "Show transcript"}
            </button>
            {expanded && (
              <div className="mt-3 border-t border-ink-line-soft pt-3">
                {loading && (
                  <p className="text-xs text-on-ink-faint flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
                    Loading transcript…
                  </p>
                )}
                {/* Every turn is a real negotiation_turns row with its own real
                    createdAt — no invented pacing, no sample dialogue. */}
                <div className="space-y-2">
                  {transcripts[n.id]?.map((turn, i) => {
                    const isBuyer = turn.speaker === "buyer";
                    return (
                      <div key={i} className={`flex ${isBuyer ? "justify-start" : "justify-end"}`}>
                        <div
                          className={`max-w-[80%] rounded-[var(--radius)] px-3 py-2 text-xs ${
                            isBuyer
                              ? "bg-ink-overlay text-on-ink"
                              : "bg-accent-wash text-on-ink border border-accent/20"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`font-medium ${isBuyer ? "text-on-ink-dim" : "text-accent-bright"}`}>
                              {isBuyer ? "Buyer" : "Merchant's agent"}
                            </span>
                            <span className="text-on-ink-faint font-mono">{formatTime(turn.createdAt)}</span>
                          </div>
                          <p>{turn.message}</p>
                          {turn.offeredUnitPricePaise !== null && (
                            <p className="mt-1 font-mono font-medium">{formatPaise(turn.offeredUnitPricePaise)}/unit</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
