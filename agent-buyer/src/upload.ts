import { readFileSync } from "node:fs";
import { env } from "./env";

/**
 * Streams the local JSONL run log to the merchant platform's theatre
 * ingest endpoint once a run ends — the only way the theatre view
 * (L19-5) can show this run, since this package holds no database
 * access. Best-effort: a failed upload never changes the run's own
 * outcome, since the log already exists locally and was the thing
 * being run for its own sake, not for the upload.
 */
export async function uploadRunLog(runId: string, logPath: string): Promise<void> {
  let rawLog: string;
  try {
    rawLog = readFileSync(logPath, "utf8");
  } catch (err) {
    console.error(`agent-buyer: could not read run log at ${logPath} to upload:`, err);
    return;
  }

  try {
    const res = await fetch(new URL("/api/agent/theatre/ingest", env.THIRDMAN_BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.THIRDMAN_AGENT_KEY}` },
      body: JSON.stringify({ runId, rawLog }),
    });
    if (!res.ok) {
      console.error(`agent-buyer: theatre ingest failed (${res.status}): ${await res.text()}`);
      return;
    }
    console.log(`agent-buyer: run log uploaded to the theatre view.`);
  } catch (err) {
    console.error("agent-buyer: theatre ingest request failed:", err);
  }
}
