import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The structural proof this package's own governing rule holds — the
 * same shape as the parent app's memory-never-influences-gate.test.ts
 * static import check (Layer 18): the demo is real because the two
 * sides genuinely cannot see each other. agent-buyer/ must never import
 * the parent app's src/lib/* (its schema, money.ts, or any type) and
 * must never reference DATABASE_URL — it talks to the product
 * exclusively over MCP/HTTP, exactly as a stranger's agent would
 * (plans/layer-19-adversarial-buyer.md's governing rule).
 */

const SRC_DIR = resolve(__dirname);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("agent-buyer/ isolation", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  it("has at least one source file to check (sanity)", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("imports nothing from the parent app's src/lib/*", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      // Matches @/lib/... (the parent app's path alias) or a relative
      // escape into ../src/lib or ../../src/lib — either would be a
      // real leak of the trust boundary this layer exists to prove.
      if (/from\s+["']@\/lib\//.test(content) || /from\s+["'](\.\.\/)+src\/lib\//.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never references DATABASE_URL", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      if (content.includes("DATABASE_URL")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json declares no dependency on drizzle-orm or postgres (no DB client at all)", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(allDeps["drizzle-orm"]).toBeUndefined();
    expect(allDeps["postgres"]).toBeUndefined();
    expect(allDeps["pg"]).toBeUndefined();
  });
});
