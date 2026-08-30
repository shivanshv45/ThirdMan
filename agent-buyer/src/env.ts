import { z } from "zod";

/**
 * The only place in this package allowed to read process.env directly —
 * mirrors the parent app's src/lib/env.ts discipline, but this schema is
 * independent and deliberately minimal: this package must never import
 * anything from the parent app (see plans/layer-19-adversarial-buyer.md's
 * governing rule). Absence of any required variable is a clear startup
 * error naming the missing variable, never a silent default.
 */

const envSchema = z.object({
  // The merchant platform's own public base URL — e.g.
  // http://localhost:3000 in development, or the deployed origin. The
  // buyer agent talks to it exclusively over MCP/HTTP, exactly as a
  // stranger's agent would.
  THIRDMAN_BASE_URL: z.string().url("THIRDMAN_BASE_URL must be a valid URL"),
  // A real agent API key issued through the normal /dashboard/agents
  // flow (or a scratch agent seeded by the parent app's own scripts/
  // for a repeatable demo run) — the same Bearer scheme every other
  // agent integration uses. This package holds no other credential.
  THIRDMAN_AGENT_KEY: z.string().min(1, "THIRDMAN_AGENT_KEY is required"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`agent-buyer: invalid environment configuration. Fix .env.local and restart:\n${problems}`);
  }
  return result.data;
}

export const env = loadEnv();
