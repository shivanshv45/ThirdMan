import { resolve } from "node:path";
import { runBuyerAgent } from "./loop";
import { uploadRunLog } from "./upload";

/**
 * Entrypoint: `npm run run` inside agent-buyer/. Reads the goal from
 * argv (or a default), runs the loop once, and prints the outcome. The
 * run log is written to run-logs/<timestamp>.jsonl — what the theatre
 * view (L19-5) reads.
 */

const DEFAULT_GOAL =
  "Buy 3 units of the cheapest coffee bag variant you can find from this merchant, spending no more than your available budget in total. " +
  "If the listed price doesn't fit your budget, try negotiating a lower price before giving up.";

async function main() {
  const goal = process.argv.slice(2).join(" ").trim() || DEFAULT_GOAL;
  const logPath = resolve(process.cwd(), "run-logs", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

  console.log(`agent-buyer: starting run\n  goal: ${goal}\n  log: ${logPath}\n`);

  const result = await runBuyerAgent(goal, logPath);
  await uploadRunLog(result.runId, logPath);

  console.log(`\nagent-buyer: run ${result.runId} ended as "${result.outcome}"`);
  console.log(`  steps: ${result.stepCount}, purchase attempts: ${result.purchaseAttempts}`);
  console.log(`  final message: ${result.message}`);

  process.exit(result.outcome === "succeeded" ? 0 : result.outcome === "error" ? 1 : 0);
}

main().catch((err) => {
  console.error("agent-buyer: fatal error:", err);
  process.exit(1);
});
