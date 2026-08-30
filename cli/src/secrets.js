import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
/**
 * L20-6 / the governing rule: no credential is ever written to a file
 * this tool creates. The agent API key goes to .env.local, and this
 * module verifies .env.local is gitignored before writing — refusing,
 * loudly, if it is not. CLAUDE.md rule 5 enforced by the tool rather
 * than assumed. See scripts/demo-failure-cli-refuses-unsafe-write.ts.
 */
export class UnsafeSecretWriteError extends Error {
}
const ENV_LOCAL_PATH = ".env.local";
/** True only when .env.local is covered by a real .gitignore entry — never assumed, always checked against the repo's own file. */
export function envLocalIsGitignored(scope) {
    if (!scope.exists(".gitignore"))
        return false;
    return scope.isGitignored(ENV_LOCAL_PATH) || scope.isGitignored(".env*") || scope.isGitignored(".env.local");
}
/**
 * Writes (or appends to) .env.local with the given key. Throws
 * UnsafeSecretWriteError, refusing the write entirely, if .env.local is
 * not gitignored — never writes the secret anyway "just this once."
 */
export function writeAgentKeyToEnvLocal(scope, key, value) {
    if (!envLocalIsGitignored(scope)) {
        throw new UnsafeSecretWriteError(`Refusing to write ${key} to .env.local: this project's .gitignore does not cover .env.local, so writing the key here risks committing it to source control. Add ".env.local" (or ".env*") to your .gitignore and run this again.`);
    }
    const abs = scope.resolve(ENV_LOCAL_PATH);
    const line = `${key}=${value}\n`;
    if (!existsSync(abs)) {
        writeFileSync(abs, line, "utf8");
        return;
    }
    const existing = readFileSync(abs, "utf8");
    const keyPattern = new RegExp(`^${key}=.*$`, "m");
    if (keyPattern.test(existing)) {
        writeFileSync(abs, existing.replace(keyPattern, line.trimEnd()), "utf8");
    }
    else {
        appendFileSync(abs, existing.endsWith("\n") || existing.length === 0 ? line : `\n${line}`);
    }
}
//# sourceMappingURL=secrets.js.map