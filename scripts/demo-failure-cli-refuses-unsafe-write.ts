import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectScope } from "../cli/src/fs-scope";
import { envLocalIsGitignored, writeAgentKeyToEnvLocal, UnsafeSecretWriteError } from "../cli/src/secrets";

/**
 * Layer 20's required failure demo (plans/layer-20-merchant-cli.md's
 * L20-9): the CLI encountering a project where .env.local is not
 * gitignored, refusing to write the agent key, and explaining why. A
 * real refusal, same shape as this repo's other demo scripts, except
 * this one exercises cli/ — a standalone package with no database of
 * its own — so it imports directly from cli/src rather than src/lib.
 * Self-cleaning: creates its own temp fixture, tears it down after,
 * safe to run twice back to back.
 */
async function main() {
  console.log("=== Demo: the CLI refuses to write a secret when .env.local isn't gitignored ===\n");

  const root = mkdtempSync(path.join(tmpdir(), "thirdman-failure-demo-"));
  try {
    console.log(`1. A fresh project at ${root}, with a .gitignore that does NOT cover .env.local:`);
    writeFileSync(path.join(root, ".gitignore"), "node_modules\ndist\n");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo-store" }));
    console.log("   .gitignore contents: node_modules, dist (no .env.local entry)\n");

    const scope = new ProjectScope(root);

    console.log("2. Checking envLocalIsGitignored(scope) — the same check `init` runs before ever writing a key:");
    const gitignored = envLocalIsGitignored(scope);
    console.log(`   result: ${gitignored}`);
    if (gitignored !== false) throw new Error("Expected envLocalIsGitignored to be false for this fixture — demo scenario is broken");

    console.log("\n3. Attempting to write a real-shaped agent key to .env.local anyway:");
    let refused = false;
    let refusalMessage = "";
    try {
      writeAgentKeyToEnvLocal(scope, "THIRDMAN_AGENT_API_KEY", "sk_live_demo_key_do_not_use");
    } catch (err) {
      if (err instanceof UnsafeSecretWriteError) {
        refused = true;
        refusalMessage = err.message;
      } else {
        throw err;
      }
    }

    if (!refused) throw new Error("Expected UnsafeSecretWriteError to be thrown — demo scenario is broken");
    console.log(`   REFUSED: "${refusalMessage}"\n`);

    console.log("4. Confirming .env.local was never created on disk:");
    const envLocalExists = existsSync(path.join(root, ".env.local"));
    console.log(`   .env.local exists: ${envLocalExists}`);
    if (envLocalExists) throw new Error("Expected no .env.local to have been written — demo scenario is broken");

    console.log(
      "\nThe key was never written anywhere — the tool refused loudly and explained why, exactly as plans/layer-20-merchant-cli.md's governing rule requires.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log("\n=== Demo scenario complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo FAILED:", err);
    process.exit(1);
  });
