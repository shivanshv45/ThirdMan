import { randomUUID } from "node:crypto";
import { LlmAgent, Runner, InMemorySessionService } from "@google/adk";
import { createBuyerToolset } from "./mcp-client";
import { BUYER_MODEL_ID } from "./model";
import { checkCeilings, DEFAULT_RUN_BOUNDS, type RunBounds, type RunOutcome } from "./bounds";
import { RunLog, extractMoneyActionId } from "./run-log";

/**
 * The agentic loop: goal in, model proposes a tool call, the client
 * executes it against the real server, the result goes back to the
 * model, repeat until the goal is met, refused terminally, or a ceiling
 * is reached. The ceilings themselves are enforced entirely in
 * beforeToolCallback/state tracked here — code, never the model, per
 * this agent's own "AI decides judgment, code decides limits" rule
 * (plans/layer-19-adversarial-buyer.md).
 */

export interface RunResult {
  runId: string;
  outcome: RunOutcome | "succeeded";
  message: string;
  stepCount: number;
  purchaseAttempts: number;
}

/**
 * The merchant's own MCP endpoint rate-limits at 60 req/min per agent
 * (agent-auth.ts's checkRateLimit) and returns a plain JSON 429 over
 * the MCP transport — a real bound this agent must respect, not treat
 * as a Gemini quota issue. Only Gemini's own rate-limit/quota errors
 * trigger this agent's own backoff-and-retry; hitting the merchant's
 * limiter ends the run honestly as "error" (a bug in this agent's own
 * pacing) rather than misreporting the cause.
 */
function isGeminiRateLimit(message: string): boolean {
  if (/too many requests\. please slow down/i.test(message)) return false;
  return /rate.?limit|resource.?exhausted|quota/i.test(message) || /\b429\b/.test(message);
}

/**
 * Pulls the MCP tool's real JSON payload out of the CallToolResult shape
 * (see mcp_tool.js: runAsync returns the raw MCP result unchanged). A
 * call short-circuited by this agent's own beforeToolCallback (a
 * ceiling hit) never reaches the server at all — afterToolCallback then
 * sees the plain {decision, reason} object beforeToolCallback returned,
 * not an MCP content array, so that shape is passed through unchanged
 * rather than treated as unparseable.
 */
function parseMcpToolResponse(response: Record<string, unknown>): unknown {
  const content = response.content;
  if (!Array.isArray(content) || content.length === 0) return response;
  const first = content[0] as { type?: string; text?: string };
  if (first?.type !== "text" || typeof first.text !== "string") return response;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

export async function runBuyerAgent(
  goal: string,
  logPath: string,
  bounds: RunBounds = DEFAULT_RUN_BOUNDS,
): Promise<RunResult> {
  const startedAtMs = Date.now();
  const log = new RunLog(logPath);
  let attempt = 0;

  // Rate-limit retries are bounded and threaded across attempts here,
  // not reset per attempt — otherwise a persistent rate limit would
  // retry forever instead of ending as the real "rate_limited" outcome.
  while (true) {
    const result = await attemptRun(goal, log, bounds, startedAtMs);
    if (result.outcome !== "rate_limited" || attempt >= bounds.maxRateLimitRetries) {
      return result;
    }
    attempt += 1;
    const backoffMs = bounds.rateLimitBackoffBaseMillis * 2 ** (attempt - 1);
    log.step(result.runId, -1, `Rate limited by Gemini — retrying in ${backoffMs}ms (attempt ${attempt}/${bounds.maxRateLimitRetries}).`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

async function attemptRun(goal: string, log: RunLog, bounds: RunBounds, startedAtMs: number): Promise<RunResult> {
  const runId = randomUUID();
  log.started(runId, goal);

  const toolset = createBuyerToolset();
  const state = { stepCount: 0, purchaseAttempts: 0, startedAtMs };

  // Resolved once per run, not once per agent turn. The MCP server is
  // stateless (no session id), so every listTools()/callTool() round
  // trip is a fresh handshake — several real HTTP requests each. Handing
  // LlmAgent the raw toolset means it calls getTools() (a full
  // listTools() handshake) on every single turn on top of the tool
  // calls themselves, which is what actually tripped the merchant's own
  // 60/min MCP rate limit (agent-auth.ts) during testing — framework
  // chattiness, not a real scenario this layer is meant to demonstrate.
  const tools = await toolset.getTools();

  const agent = new LlmAgent({
    name: "buyer_agent",
    model: BUYER_MODEL_ID,
    instruction:
      "You are an autonomous buyer agent. You have a goal and a budget you believe you have. " +
      "Discover the merchant's tools and use them to try to complete the goal within your budget. " +
      "If a purchase is refused, read the reason and adapt — try a different variant, a negotiation, " +
      "or a smaller quantity, rather than repeating the exact same call. State your reasoning briefly " +
      "before each tool call. If you cannot complete the goal within the rules, say so plainly instead " +
      "of pretending you succeeded.",
    tools,
    beforeToolCallback: ({ tool, args }) => {
      const nowMs = Date.now();
      const ceilingHit = checkCeilings(bounds, { ...state, nowMs });
      if (ceilingHit) {
        return { decision: "deny", reason: `Buyer agent's own ${ceilingHit} ceiling reached — call blocked before it reached the server.` };
      }
      if (tool.name === "purchase") {
        state.purchaseAttempts += 1;
        if (state.purchaseAttempts > bounds.maxPurchaseAttempts) {
          return { decision: "deny", reason: "Buyer agent's own purchase-attempt ceiling reached — call blocked before it reached the server." };
        }
      }
      state.stepCount += 1;
      const stepIndex = log.nextStepIndex();
      log.toolCall(runId, stepIndex, tool.name, args);
      return undefined;
    },
    afterToolCallback: ({ tool, response }) => {
      const parsed = parseMcpToolResponse(response as Record<string, unknown>);
      const moneyActionId = extractMoneyActionId(parsed);
      log.toolResult(runId, state.stepCount - 1, tool.name, parsed ?? response, moneyActionId);
      return undefined;
    },
  });

  const sessionService = new InMemorySessionService();
  const appName = "agent-buyer";
  const userId = "buyer-agent";
  const runner = new Runner({ appName, agent, sessionService });

  let outcome: RunOutcome | "succeeded" = "succeeded";
  let finalMessage = "";

  try {
    const session = await sessionService.createSession({ appName, userId });

    // Multi-turn: the model works in single-agent-turn increments (a
    // burst of tool calls followed by either more tool calls or a plain
    // text reply). A turn that issues no tool call at all is the
    // model's own claim that it's done — succeeded or genuinely stuck —
    // so that's the natural stop. Every other turn gets prompted to
    // continue, bounded throughout by the same deterministic ceilings
    // beforeToolCallback already enforces per tool call.
    let nextMessage = goal;
    let turnMadeToolCall = true;

    while (turnMadeToolCall) {
      const nowMs = Date.now();
      const ceilingHit = checkCeilings(bounds, { ...state, nowMs });
      if (ceilingHit) {
        outcome = ceilingHit;
        break;
      }

      turnMadeToolCall = false;
      let turnProducedAnything = false;
      const events = runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: nextMessage }] },
      });

      for await (const event of events) {
        // A model failure (rate limit, quota, transient error) surfaces
        // here as a normal event carrying errorCode/errorMessage, not a
        // thrown exception — observed live: Gemini's real free-tier
        // 429 (20 req/min on gemini-3.5-flash) comes back this way, so
        // catch{} alone would never see it and the turn would look
        // silently empty instead.
        if (event.errorCode) {
          throw new Error(`${event.errorCode}: ${event.errorMessage ?? "model call failed"}`);
        }

        const parts = event.content?.parts ?? [];
        if (parts.some((p) => p.functionCall)) {
          turnMadeToolCall = true;
          turnProducedAnything = true;
        }

        const text = parts.map((p) => p.text).filter((t): t is string => Boolean(t)).join(" ").trim();
        if (text) {
          turnProducedAnything = true;
          finalMessage = text;
          // A step entry for pure reasoning/final-answer text, distinct
          // from the tool_call/tool_result entries beforeToolCallback
          // and afterToolCallback already wrote for actual tool
          // activity — real model output only, never fabricated.
          log.step(runId, state.stepCount, text);
        }
      }

      // A turn with neither a tool call nor any text (and no error
      // event either, handled above) is not a genuine "the model is
      // done" signal — it's an empty/interrupted turn. Reporting that
      // as "succeeded" would be a fabricated outcome, so it's a real,
      // distinguishable error instead.
      if (!turnProducedAnything) {
        throw new Error("Agent turn produced neither a tool call nor any text — treating as a failed turn, not a natural stop.");
      }

      nextMessage =
        "Continue working toward the goal. If you have completed it, or cannot complete it within your bounds, say so plainly and stop calling tools.";

      if (turnMadeToolCall && bounds.interTurnPauseMillis > 0) {
        await new Promise((resolve) => setTimeout(resolve, bounds.interTurnPauseMillis));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isGeminiRateLimit(message)) {
      outcome = "rate_limited";
      finalMessage = "Gemini rate limit hit on this attempt.";
    } else {
      outcome = "error";
      finalMessage = message;
    }
  } finally {
    await toolset.close();
  }

  log.ended(runId, outcome, finalMessage || `Run ended as ${outcome}.`);
  return { runId, outcome, message: finalMessage, stepCount: state.stepCount, purchaseAttempts: state.purchaseAttempts };
}
