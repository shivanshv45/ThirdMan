/**
 * The embed widget's script tag, in exactly one place. `cli/`'s
 * generate/snippet.ts (L20-5) re-exports these rather than defining its
 * own, and src/lib/integration-artifacts.ts (L24-5, the dashboard's
 * copy-paste artifacts surface) imports them directly — so the exact
 * bytes a merchant is told to paste are identical whether they got there
 * via `npx thirdman init` or the dashboard.
 */

export const SNIPPET_MARKER_START = "thirdman:embed:start";
export const SNIPPET_MARKER_END = "thirdman:embed:end";

export function buildSnippet(appOrigin: string, publishableKey: string): string {
  return `<!-- ${SNIPPET_MARKER_START} -->\n<script async src="${appOrigin}/api/embed/v1.js" data-embed-key="${publishableKey}"></script>\n<!-- ${SNIPPET_MARKER_END} -->`;
}
