/**
 * Layer 24-2: the one place a check turns "this file has a problem" into
 * "this file has a problem on line N" — what makes a Problems-panel
 * squiggle possible instead of just a paragraph in a terminal (see the
 * plan's own framing of the VS Code extension's whole reason to exist).
 * Pure string search, 1-indexed to match every editor's own line
 * numbering. Returns null rather than guessing when no line matches,
 * same honesty rule as every other "could not determine" case in this
 * codebase — a wrong line number pointing at the wrong code is worse
 * than no line number at all.
 */
export function findLineNumber(content, matcher) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i]))
            return i + 1;
    }
    return null;
}
/** Finds the first line whose lowercased content contains needle (case-insensitive substring, not a regex) — used for constant strings like "captcha" or a SKU literal. */
export function findLineContaining(content, needle) {
    const lines = content.split("\n");
    const target = needle.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(target))
            return i + 1;
    }
    return null;
}
//# sourceMappingURL=find-line.js.map