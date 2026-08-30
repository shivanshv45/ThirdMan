import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

export default defineConfig({
  test: {
    env: {
      // vitest doesn't get Node's --env-file flag applied to it, so load
      // .env.local explicitly for tests that touch the real database.
      ...loadEnvLocal(),
    },
    // agent-buyer/ is a separate, standalone package (Layer 19) — it is
    // deliberately outside this app's build and test run. Its own
    // deterministic ceilings are unit-tested from inside its own
    // package; this repo's suite only tests the surfaces it calls.
    exclude: ["**/node_modules/**", "agent-buyer/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

function loadEnvLocal(): Record<string, string> {
  const envPath = path.resolve(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return {};

  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}
