export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <div className="animate-pulse space-y-2">
        <div className="h-8 w-56 bg-ink-overlay rounded-[var(--radius)]" />
        <div className="h-4 w-96 max-w-full bg-ink-overlay rounded-[var(--radius)]" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 animate-pulse">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-ink-raised border border-ink-line rounded-[var(--radius-lg)]" />
        ))}
      </div>
      <div className="space-y-2 animate-pulse">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 bg-ink-raised border border-ink-line rounded-[var(--radius-lg)]" />
        ))}
      </div>
    </div>
  );
}
