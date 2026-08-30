#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Runs the real TypeScript source directly via tsx rather than requiring
// a separate build step — matches this repo's own "npm run script" and
// agent-buyer's "npm run run" convention (both node --env-file + tsx),
// so `npx thirdman` behaves the same whether run from an npm install or
// this repo's own checkout.
const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(here, "..", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const entry = path.join(here, "..", "src", "cli.ts");

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
