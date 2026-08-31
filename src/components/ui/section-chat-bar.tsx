"use client";

import { useState, useTransition } from "react";
import { Sparkles, X } from "lucide-react";

/** One exchange in the clarification back-and-forth, oldest first. */
export interface ChatTurn {
  role: "merchant" | "assistant";
  text: string;
}

export interface DraftOutcome<P> {
  ok: boolean;
  proposal?: P;
  /** A follow-up question — the merchant's next reply is appended to history and redrafted, not treated as a fresh instruction. */
  question?: string;
  reason?: string;
}

export interface SectionChatBarProps<P> {
  /** Placeholder text shown in the input, phrased as a real example for this section. */
  placeholder: string;
  /** Calls the section's own draft Server Action with the full conversation so far. Never writes anything. */
  onDraft: (history: ChatTurn[]) => Promise<DraftOutcome<P>>;
  /** Calls the section's own confirm Server Action. Only reachable after a human clicks Apply. */
  onConfirm: (proposal: P) => Promise<{ ok: boolean; reason?: string }>;
  /** Renders the drafted proposal's real fields for review before the merchant confirms it. */
  renderProposal: (proposal: P) => React.ReactNode;
}

/**
 * The per-section chat bar. A merchant types what they want in plain
 * English; a model drafts a structured proposal against that section's
 * own closed schema; nothing is written until the merchant reviews the
 * exact drafted values and clicks Apply.
 *
 * This component never calls a mutation directly and never trusts the
 * model's own claim that something succeeded — onConfirm's result is
 * what decides whether the success state renders. See
 * plans/rewards-schema.ts and *.isolation.test.ts for the structural
 * proof that drafting and writing are two different server modules,
 * not just two branches of the same one.
 */
export function SectionChatBar<P>({ placeholder, onDraft, onConfirm, renderProposal }: SectionChatBarProps<P>) {
  const [instruction, setInstruction] = useState("");
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [proposal, setProposal] = useState<P | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [isDrafting, startDrafting] = useTransition();
  const [isApplying, startApplying] = useTransition();

  function handleDraft() {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    setError(null);
    setApplied(false);
    const nextHistory: ChatTurn[] = [...history, { role: "merchant", text: trimmed }];
    setInstruction("");
    startDrafting(async () => {
      const result = await onDraft(nextHistory);
      if (result.ok && result.proposal) {
        setHistory([]);
        setQuestion(null);
        setProposal(result.proposal);
      } else if (result.question) {
        setHistory([...nextHistory, { role: "assistant", text: result.question }]);
        setQuestion(result.question);
        setProposal(null);
      } else {
        setHistory([]);
        setQuestion(null);
        setProposal(null);
        setError(result.reason ?? "Could not draft a change from that.");
      }
    });
  }

  function handleApply() {
    if (!proposal) return;
    startApplying(async () => {
      const result = await onConfirm(proposal);
      if (result.ok) {
        setApplied(true);
        setProposal(null);
        setInstruction("");
      } else {
        setError(result.reason ?? "Could not apply that change.");
      }
    });
  }

  function handleDismiss() {
    setProposal(null);
    setQuestion(null);
    setHistory([]);
    setError(null);
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised/80 backdrop-blur-md px-3 py-2.5 focus-within:border-accent/50 transition-colors duration-[var(--dur-fast)]">
        <Sparkles size={16} className="text-accent-bright shrink-0" aria-hidden="true" />
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isDrafting) handleDraft();
          }}
          placeholder={question ?? placeholder}
          className="flex-1 min-w-0 bg-transparent text-sm text-on-ink placeholder:text-on-ink-faint outline-none"
        />
        <button
          type="button"
          onClick={handleDraft}
          disabled={isDrafting || !instruction.trim()}
          className="shrink-0 text-xs font-medium text-accent hover:text-accent-bright disabled:text-on-ink-faint disabled:cursor-not-allowed transition-colors duration-[var(--dur-fast)] px-2 py-1"
        >
          {isDrafting ? "Thinking…" : question ? "Reply" : "Draft"}
        </button>
      </div>

      {question && (
        <div className="mt-2 flex items-start gap-2 text-xs text-accent-bright bg-accent-wash/40 border border-accent/30 rounded-[var(--radius)] px-3 py-2">
          <span className="flex-1">{question}</span>
          <button type="button" onClick={handleDismiss} aria-label="Start over" className="shrink-0 text-on-ink-faint hover:text-on-ink">
            <X size={13} />
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-2 text-xs text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 text-on-ink-faint hover:text-on-ink">
            <X size={13} />
          </button>
        </div>
      )}

      {proposal && (
        <div className="mt-2 rounded-[var(--radius-lg)] border border-accent/30 bg-accent-wash/40 px-4 py-3.5">
          <div className="text-[var(--t-label)] uppercase tracking-[0.08em] text-accent-bright font-medium mb-2">
            Drafted change, nothing applied yet
          </div>
          <div className="text-sm text-on-ink mb-3">{renderProposal(proposal)}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleApply}
              disabled={isApplying}
              className="text-xs font-semibold px-3 py-1.5 rounded-[var(--radius)] bg-accent text-accent-ink hover:bg-accent-bright disabled:opacity-50 transition-colors duration-[var(--dur-fast)]"
            >
              {isApplying ? "Applying…" : "Apply"}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={isApplying}
              className="text-xs font-medium px-3 py-1.5 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink transition-colors duration-[var(--dur-fast)]"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {applied && !proposal && (
        <div className="mt-2 text-xs text-allow-bright bg-allow-wash border border-allow-line rounded-[var(--radius)] px-3 py-2">
          Applied. The page below reflects the real change.
        </div>
      )}
    </div>
  );
}
