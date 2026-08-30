"use client";

import { useState } from "react";
import { Surface, Field, Input, EmptyState, Button } from "@/components/ui";

interface StoreCheck {
  id: string;
  label: string;
  passed: boolean;
  notEvaluated?: { reason: string };
}

interface IntegrationArtifact {
  checkId: string;
  title: string;
  placement: string;
  content: string;
  note: string;
}

/**
 * L24-5: runs the same Instant Audit the public /audit page runs
 * (reusing /api/audit — one engine, per the layer's governing claim),
 * then asks the server which of the failed checks have an exact,
 * paste-able artifact — never a guess rendered client-side.
 */
export function CopyPasteArtifacts() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<IntegrationArtifact[] | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setArtifacts(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not audit this URL.");
        return;
      }
      const failedIds: string[] = (data.checks as StoreCheck[]).filter((c) => !c.notEvaluated && !c.passed).map((c) => c.id);

      const artifactsRes = await fetch("/api/audit/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkIds: failedIds }),
      });
      const artifactsData = await artifactsRes.json();
      setArtifacts(artifactsRes.ok ? artifactsData.artifacts : []);
    } catch {
      setError("Could not reach the audit service. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  async function copy(id: string, content: string) {
    await navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1">
          <Field label="Your store URL" help="Runs the same fetch-based audit as the public Instant Audit — every artifact below answers a real, failed check.">
            <Input type="url" required placeholder="https://your-store.example.com" value={url} onChange={(e) => setUrl(e.target.value)} disabled={loading} />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={loading || !url.trim()} pendingLabel="Auditing…">
          Find fixes
        </Button>
      </form>

      {error && <p className="text-sm text-deny-bright">{error}</p>}

      {artifacts !== null && artifacts.length === 0 && !error && (
        <EmptyState title="Nothing to paste" description="Every check with a known generic fix already passed, or the failing checks need real product work rather than a snippet." />
      )}

      {artifacts !== null && artifacts.length > 0 && (
        <div className="space-y-3">
          {artifacts.map((artifact) => (
            <Surface key={artifact.checkId} variant="flush" className="p-4 space-y-2">
              <div>
                <p className="text-sm font-medium text-on-ink">{artifact.title}</p>
                <p className="text-xs text-on-ink-faint mt-0.5">Paste into: {artifact.placement}</p>
              </div>
              <p className="text-sm text-on-ink-dim">{artifact.note}</p>
              <pre className="font-mono text-xs bg-ink border border-ink-line rounded-[var(--radius)] px-3 py-2.5 overflow-x-auto text-on-ink whitespace-pre-wrap break-all">
                {artifact.content}
              </pre>
              <button
                type="button"
                onClick={() => copy(artifact.checkId, artifact.content)}
                className="text-xs px-2.5 py-1.5 rounded-[var(--radius)] border border-ink-line text-on-ink-dim hover:text-on-ink hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)]"
              >
                {copiedId === artifact.checkId ? "Copied" : "Copy"}
              </button>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
