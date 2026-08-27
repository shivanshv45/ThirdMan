"use client";

import Link from "next/link";

/**
 * Catches anything thrown by a Server Action or a page in the dashboard
 * tree (e.g. dashboard-mutations.ts's "Agent not found", gate.ts's
 * "Escalation ... was already resolved") that isn't already handled by a
 * form's own error state. Without this, a thrown error rendered Next's
 * default unstyled error page instead of something a merchant can act on.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center py-16">
      <div className="max-w-lg text-center space-y-4">
        <h1 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink">Something went wrong</h1>
        <p className="text-sm text-on-ink-dim bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2 font-mono">
          {error.message || "An unexpected error occurred."}
        </p>
        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="px-4 py-2 rounded-[var(--radius)] bg-accent text-accent-ink text-sm font-medium hover:bg-accent-bright transition-colors duration-[var(--dur-fast)]"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-[var(--radius)] border border-ink-line text-on-ink text-sm hover:border-on-ink-faint transition-colors duration-[var(--dur-fast)]"
          >
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
