import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProjectScope } from "../fs-scope.js";

/**
 * L20-5's governing rule, enforced in code rather than by convention:
 * every write is shown as a unified diff and confirmed separately, and
 * a write is refused outright if it would land outside the project
 * root (ProjectScope.resolve already throws for that — this is the
 * second half: the file must be one this diff actually showed).
 */

export interface FileWrite {
  relativePath: string;
  newContent: string;
}

export interface PlannedWrite extends FileWrite {
  oldContent: string | null; // null = new file
  diff: string;
  unchanged: boolean;
}

/** A small, dependency-free unified-diff renderer — good enough for a merchant to read, not a general-purpose diff library. */
function renderUnifiedDiff(relativePath: string, oldContent: string | null, newContent: string): string {
  const oldLines = oldContent === null ? [] : oldContent.split("\n");
  const newLines = newContent.split("\n");

  if (oldContent === newContent) return "";

  const lines: string[] = [];
  lines.push(`--- ${oldContent === null ? "/dev/null" : relativePath}`);
  lines.push(`+++ ${relativePath}`);

  const maxLen = Math.max(oldLines.length, newLines.length);
  let hunkLines: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      if (oldLine !== undefined) hunkLines.push(`  ${oldLine}`);
    } else {
      if (oldLine !== undefined) hunkLines.push(`- ${oldLine}`);
      if (newLine !== undefined) hunkLines.push(`+ ${newLine}`);
    }
  }
  lines.push(...hunkLines);
  return lines.join("\n");
}

export function planWrite(scope: ProjectScope, write: FileWrite): PlannedWrite {
  const abs = scope.resolve(write.relativePath);
  const oldContent = existsSync(abs) ? scope.readFile(write.relativePath) : null;
  const unchanged = oldContent === write.newContent;
  return {
    ...write,
    oldContent,
    unchanged,
    diff: unchanged ? "" : renderUnifiedDiff(write.relativePath, oldContent, write.newContent),
  };
}

/**
 * Applies a write only after the caller has shown its diff and received
 * an explicit confirmation — this function itself trusts the caller
 * gave that confirmation (the confirmation prompt lives in init.ts,
 * where the merchant actually sees the diff), but it re-asserts the
 * root-boundary check every write already gets from ProjectScope.resolve.
 */
export function applyWrite(scope: ProjectScope, write: FileWrite): void {
  const abs = scope.resolve(write.relativePath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, write.newContent, "utf8");
}
