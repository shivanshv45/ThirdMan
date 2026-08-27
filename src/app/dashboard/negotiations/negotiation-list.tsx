"use client";

import { useState, useTransition } from "react";
import { formatPaise } from "@/lib/money";
import { getTranscript, type TranscriptTurn } from "./actions";
import type { NegotiationRow } from "@/lib/dashboard";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const statusStyles: Record<string, { text: string; border: string }> = {
  agreed: { text: "text-green-700", border: "border-green-500" },
  redeemed: { text: "text-green-700", border: "border-green-500" },
  refused_turns_exhausted: { text: "text-red-700", border: "border-red-500" },
  open: { text: "text-amber-700", border: "border-amber-500" },
  expired: { text: "text-gray-500", border: "border-gray-300" },
};

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
        const style = statusStyles[n.status] ?? { text: "text-gray-500", border: "border-gray-300" };
        const expanded = expandedId === n.id;

        return (
          <li key={n.id} className={`border-l-4 ${style.border} border rounded px-3 py-2 text-sm`}>
            <div className="flex items-center justify-between">
              <span>
                <span className="font-medium">{n.variantSku}</span> x{n.quantity} —{" "}
                <span className={style.text}>{statusLabels[n.status] ?? n.status}</span>
              </span>
              <span className="text-xs text-gray-400">{formatDate(n.resolvedAt ?? n.createdAt)}</span>
            </div>
            <p className="mt-1 text-gray-600">
              Catalogue {formatPaise(n.catalogueUnitPricePaise)}/unit, floor {formatPaise(n.floorUnitPricePaise)}/unit
              {n.agreedUnitPricePaise !== null && <> — agreed at {formatPaise(n.agreedUnitPricePaise)}/unit</>}
              {" "}({n.buyerTurnCount} counter-offer{n.buyerTurnCount === 1 ? "" : "s"})
            </p>
            <button type="button" onClick={() => toggle(n.id)} className="text-xs text-blue-600 hover:underline mt-1">
              {expanded ? "Hide transcript" : "Show transcript"}
            </button>
            {expanded && (
              <div className="mt-2 border-t pt-2 space-y-1">
                {isPending && !transcripts[n.id] && <p className="text-xs text-gray-400">Loading…</p>}
                {transcripts[n.id]?.map((turn, i) => (
                  <p key={i} className="text-xs">
                    <span className="font-medium">{turn.speaker === "buyer" ? "Buyer" : "Merchant's agent"}:</span>{" "}
                    {turn.message}
                    {turn.offeredUnitPricePaise !== null && <span className="text-gray-500"> ({formatPaise(turn.offeredUnitPricePaise)}/unit)</span>}
                  </p>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
