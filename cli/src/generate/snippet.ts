import type { FileWrite } from "./diff.js";
import type { StackKind } from "../types.js";
import { SNIPPET_MARKER_START, SNIPPET_MARKER_END, buildSnippet } from "../../../shared/embed-snippet.js";

/**
 * L20-5: the highest-risk write this tool makes — it modifies a file
 * the merchant wrote. Two invariants hold this safe:
 *
 * 1. Idempotent — running init twice never produces two snippets. Every
 *    injection is wrapped in SNIPPET_MARKER_START/END; a second run
 *    finds the existing markers and replaces the block in place rather
 *    than appending a duplicate.
 * 2. Detectable for removal — the markers are what a merchant (or this
 *    tool, on request) greps for to remove the snippet cleanly.
 *
 * The marker constants and buildSnippet itself come from
 * shared/embed-snippet.ts, the same file src/lib/integration-
 * artifacts.ts (L24-5) imports — see that file's header.
 */

export { SNIPPET_MARKER_START, SNIPPET_MARKER_END, buildSnippet };

/**
 * Replaces an existing marked block if present, otherwise inserts before
 * insertBeforePattern (or appends at the end). The marker regex matches
 * the bare marker text regardless of comment syntax (an HTML comment or
 * a JSX comment), so a JSX-wrapped snippet from a prior run is still
 * found and replaced in place on re-run — this is what makes injection
 * idempotent across both comment styles. Pure string transform — no
 * filesystem access — so it's directly testable against fixture strings.
 */
export function injectSnippet(existingContent: string, snippet: string, insertBeforePattern: RegExp | null): string {
  const markerRegex = new RegExp(`(<!--|\\{/\\*)\\s*${escapeRegex(SNIPPET_MARKER_START)}\\s*(-->|\\*/\\})[\\s\\S]*?(<!--|\\{/\\*)\\s*${escapeRegex(SNIPPET_MARKER_END)}\\s*(-->|\\*/\\})`);
  if (markerRegex.test(existingContent)) {
    return existingContent.replace(markerRegex, snippet);
  }

  if (insertBeforePattern) {
    const match = existingContent.match(insertBeforePattern);
    if (match && match.index !== undefined) {
      return existingContent.slice(0, match.index) + snippet + "\n" + existingContent.slice(match.index);
    }
  }

  return `${existingContent}\n${snippet}\n`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where to inject per detected stack, and what the target file even is.
 * A small, explicit mapping per L20-2's instruction — not a sprawl of
 * per-framework special cases.
 */
export interface SnippetTarget {
  relativePath: string;
  insertBeforePattern: RegExp | null; // null = append at end
  wrapForJsx: boolean; // Next.js/Remix layouts need the snippet as JSX, not raw HTML
}

export function snippetTargetForStack(stack: StackKind): SnippetTarget | null {
  switch (stack) {
    case "nextjs":
      return { relativePath: "src/app/layout.tsx", insertBeforePattern: /<\/body>/, wrapForJsx: true };
    case "static_html":
      return { relativePath: "index.html", insertBeforePattern: /<\/body>/, wrapForJsx: false };
    case "remix":
    case "astro":
    case "express":
    case "hydrogen":
    case "woocommerce":
    case "unknown":
      return null; // not yet supported for automatic injection — the manual snippet is offered instead
  }
}

export function generateSnippetWrite(target: SnippetTarget, existingContent: string, appOrigin: string, publishableKey: string): FileWrite {
  const snippet = target.wrapForJsx
    ? buildSnippet(appOrigin, publishableKey).replace(/<!--(.*)-->/g, "{/*$1*/}")
    : buildSnippet(appOrigin, publishableKey);

  return {
    relativePath: target.relativePath,
    newContent: injectSnippet(existingContent, snippet, target.insertBeforePattern),
  };
}
