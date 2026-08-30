import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
/**
 * Every read and write in this tool goes through here — the one place
 * that enforces "never outside the project root, never .git, never
 * node_modules/build output." See plans/layer-20-merchant-cli.md's
 * governing rule.
 */
const ALWAYS_EXCLUDED = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "out",
    ".vercel",
    ".turbo",
]);
export class ProjectScope {
    root;
    gitignorePatterns;
    constructor(root) {
        this.root = path.resolve(root);
        this.gitignorePatterns = loadGitignorePatterns(this.root);
    }
    /** Resolves a path relative to the root and throws if it would land outside it — the one check every read/write depends on. */
    resolve(relativePath) {
        const resolved = path.resolve(this.root, relativePath);
        const relative = path.relative(this.root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Refusing to touch a path outside the project root: ${relativePath}`);
        }
        return resolved;
    }
    exists(relativePath) {
        return existsSync(this.resolve(relativePath));
    }
    readFile(relativePath) {
        return readFileSync(this.resolve(relativePath), "utf8");
    }
    isExcluded(relativePath) {
        const segments = relativePath.split(path.sep).filter(Boolean);
        if (segments.some((s) => ALWAYS_EXCLUDED.has(s)))
            return true;
        return this.isGitignored(relativePath);
    }
    isGitignored(relativePath) {
        return this.gitignorePatterns.some((pattern) => matchesGitignorePattern(relativePath, pattern));
    }
    /** Every file under root, relative paths, excluding node_modules/.git/build output/gitignored — the read surface every check runs against. */
    listFiles(subdir = ".") {
        const results = [];
        const startAbs = this.resolve(subdir);
        if (!existsSync(startAbs))
            return results;
        const walk = (absDir) => {
            let entries;
            try {
                entries = readdirSync(absDir);
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const absPath = path.join(absDir, entry);
                const relPath = path.relative(this.root, absPath);
                if (this.isExcluded(relPath))
                    continue;
                let stat;
                try {
                    stat = statSync(absPath);
                }
                catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(absPath);
                }
                else if (stat.isFile()) {
                    results.push(relPath.split(path.sep).join("/"));
                }
            }
        };
        walk(startAbs);
        return results;
    }
}
function loadGitignorePatterns(root) {
    const gitignorePath = path.join(root, ".gitignore");
    if (!existsSync(gitignorePath))
        return [];
    return readFileSync(gitignorePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}
/** A deliberately small, non-recursive-glob subset of gitignore matching — exact names, *-suffix, and leading-slash-rooted entries. Good enough to detect the common ".env.local" / "dist/" cases this tool actually needs; not a full gitignore parser. */
function matchesGitignorePattern(relativePath, pattern) {
    const normalized = relativePath.split(path.sep).join("/");
    let p = pattern.replace(/\/$/, "");
    const rooted = p.startsWith("/");
    if (rooted)
        p = p.slice(1);
    const segments = normalized.split("/");
    if (rooted) {
        return segments[0] === p || normalized === p || normalized.startsWith(`${p}/`);
    }
    if (p.includes("*")) {
        const regex = new RegExp(`^${p.split("*").map(escapeRegex).join(".*")}$`);
        return segments.some((seg) => regex.test(seg));
    }
    return segments.includes(p) || normalized === p;
}
function escapeRegex(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=fs-scope.js.map