"use client";

import { useState } from "react";
import { Surface } from "@/components/ui";
import { runIntegrationVerifyAction } from "./actions";

interface IntegrationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

interface IntegrationVerifyReport {
  checks: IntegrationCheck[];
  checkedAt: string;
}

/**
 * Layer 24-9: "Did it actually work?" — the question every integration
 * leaves unanswered. Real checks against the merchant's real state, run
 * on demand rather than assumed the moment a snippet is pasted.
 */
export function IntegrationVerifyPanel({ appOrigin }: { appOrigin: string }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<IntegrationVerifyReport | null>(null);

  async function runCheck() {
    setLoading(true);
    try {
      const result = await runIntegrationVerifyAction(appOrigin);
      setReport(result);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Surface variant="raised" className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink">Verify integration</h2>
          <p className="text-sm text-on-ink-dim mt-1">Real checks against your real, live setup — not an assumption.</p>
        </div>
        <button
          type="button"
          onClick={runCheck}
          disabled={loading}
          className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium text-sm px-3.5 py-2 bg-ink-overlay text-on-ink border border-ink-line hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading && <span aria-hidden="true" className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />}
          {loading ? "Checking…" : "Run checks"}
        </button>
      </div>

      {report && (
        <div className="space-y-2">
          {report.checks.map((check) => (
            <div key={check.id} className="flex items-start gap-3 text-sm">
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium mt-0.5 ${
                  check.passed ? "bg-allow-wash text-allow-bright" : "bg-deny-wash text-deny-bright"
                }`}
              >
                {check.passed ? "Pass" : "Fail"}
              </span>
              <div>
                <p className="text-on-ink font-medium">{check.label}</p>
                <p className="text-on-ink-dim text-xs mt-0.5">{check.detail}</p>
              </div>
            </div>
          ))}
          <p className="text-xs text-on-ink-faint pt-1">Checked {new Date(report.checkedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</p>
        </div>
      )}
    </Surface>
  );
}
