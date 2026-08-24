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
    <main className="max-w-lg mx-auto p-6 mt-16 text-center space-y-4">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-gray-600 bg-red-50 border border-red-200 rounded px-3 py-2">
        {error.message || "An unexpected error occurred."}
      </p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="px-4 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
        >
          Try again
        </button>
        <Link href="/dashboard" className="px-4 py-2 rounded border text-sm hover:bg-gray-50">
          Back to overview
        </Link>
      </div>
    </main>
  );
}
