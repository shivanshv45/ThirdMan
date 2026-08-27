import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-lg text-center space-y-4">
        <p className="text-[var(--t-label)] uppercase tracking-[0.1em] text-on-ink-faint font-medium font-mono">404</p>
        <h1 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink">Page not found</h1>
        <p className="text-sm text-on-ink-dim">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
        <Link
          href="/"
          className="inline-block px-4 py-2 rounded-[var(--radius)] bg-accent text-accent-ink text-sm font-medium hover:bg-accent-bright transition-colors duration-[var(--dur-fast)]"
        >
          Home
        </Link>
      </div>
    </main>
  );
}
