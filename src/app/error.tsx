"use client";

import Link from "next/link";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="max-w-lg mx-auto p-6 mt-24 text-center space-y-4">
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
        <Link href="/" className="px-4 py-2 rounded border text-sm hover:bg-gray-50">
          Home
        </Link>
      </div>
    </main>
  );
}
