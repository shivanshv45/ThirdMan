"use client";

import { useState } from "react";
import { Surface, Field, Input, ReadinessGauge, EmptyState } from "@/components/ui";

interface StoreCheck {
  id: string;
  label: string;
  weight: number;
  passed: boolean;
  fix?: { message: string; href?: string; file?: string };
  notEvaluated?: { reason: string };
}

interface StoreAuditReport {
  inputUrl: string;
  score: number;
  checks: StoreCheck[];
  fetchedAt: string;
  nextStep: string;
}

export function AuditForm() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<StoreAuditReport | null>(null);

  async function runAudit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setReport(null);
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
      setReport(data as StoreAuditReport);
    } catch {
      setError("Could not reach the audit service. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  const evaluatedChecks = report?.checks.filter((c) => !c.notEvaluated) ?? [];
  const notEvaluatedChecks = report?.checks.filter((c) => c.notEvaluated) ?? [];

  return (
    <div className="space-y-8">
      <Surface variant="raised" className="p-6">
        <form onSubmit={runAudit} className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <Field label="Store URL" help="We fetch only what's needed to score readiness, and discard the pages once the report is built.">
              <Input
                type="url"
                required
                placeholder="https://example-store.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
              />
            </Field>
          </div>
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium text-sm px-4 py-2.5 bg-accent text-accent-ink hover:bg-accent-bright transition-colors duration-[var(--dur-fast)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <span aria-hidden="true" className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />}
            {loading ? "Auditing…" : "Run audit"}
          </button>
        </form>
        {error && <p className="mt-3 text-sm text-deny-bright">{error}</p>}
      </Surface>

      {!report && !loading && !error && (
        <EmptyState
          title="No audit run yet"
          description="Paste a real storefront URL above. Every check is against pages we actually fetch — nothing here is guessed or fabricated."
        />
      )}

      {report && (
        <div className="space-y-8">
          <Surface variant="raised" className="p-6 flex flex-col sm:flex-row items-center gap-6">
            <ReadinessGauge score={report.score} />
            <div className="flex-1 space-y-2">
              <p className="text-sm text-on-ink-dim">
                <span className="font-mono text-on-ink">{report.inputUrl}</span>
              </p>
              <p className="text-sm text-on-ink-dim">{report.nextStep}</p>
              {notEvaluatedChecks.length > 0 && (
                <p className="text-xs text-on-ink-faint">
                  {notEvaluatedChecks.length} check{notEvaluatedChecks.length === 1 ? "" : "s"} could not be evaluated — see below. Those are excluded from the score, not counted as failures.
                </p>
              )}
            </div>
          </Surface>

          <div className="space-y-3">
            <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Checks</h2>
            <div className="space-y-2">
              {evaluatedChecks.map((check) => (
                <Surface key={check.id} variant="flush" className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                            check.passed ? "bg-allow-wash text-allow-bright" : "bg-deny-wash text-deny-bright"
                          }`}
                        >
                          {check.passed ? "Pass" : "Fail"}
                        </span>
                        <span className="text-sm text-on-ink font-medium">{check.label}</span>
                      </div>
                      {check.fix && <p className="mt-1.5 text-sm text-on-ink-dim">{check.fix.message}</p>}
                    </div>
                    <span className="text-xs text-on-ink-faint font-mono shrink-0">weight {check.weight}</span>
                  </div>
                </Surface>
              ))}
            </div>
          </div>

          {notEvaluatedChecks.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Could not be checked</h2>
              <div className="space-y-2">
                {notEvaluatedChecks.map((check) => (
                  <Surface key={check.id} variant="flush" className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-escalate-wash text-escalate-bright">Not evaluated</span>
                      <span className="text-sm text-on-ink font-medium">{check.label}</span>
                    </div>
                    <p className="mt-1.5 text-sm text-on-ink-dim">{check.notEvaluated?.reason}</p>
                  </Surface>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
