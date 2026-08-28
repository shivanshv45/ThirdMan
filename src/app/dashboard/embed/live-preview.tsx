/**
 * The appearance panel's live preview must be the real widget, not a
 * drawing of one — the no-mocks contract applies to a config preview
 * exactly as it does to an empty state (see ARCHITECTURE.md's design
 * system section). This renders the exact same /embed/[publishableKey]
 * route a merchant's own site would load, in a real iframe.
 */
export function LivePreview({ publishableKey }: { publishableKey: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-ink-line overflow-hidden w-full max-w-sm h-[32rem]">
      <iframe
        key={publishableKey}
        src={`/embed/${publishableKey}`}
        title="Live widget preview"
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
