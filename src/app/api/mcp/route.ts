import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateAgent, extractBearerKey } from "@/lib/agent-auth";
import { createMcpServerForAgent } from "@/lib/mcp-server";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * This product's own MCP server (Layer 5-4), over Streamable HTTP —
 * POST for JSON-RPC calls, GET for the optional SSE stream, DELETE to
 * end a session. Stateless (no sessionIdGenerator): every request
 * re-authenticates via its own bearer token and a fresh McpServer
 * instance is built per request, so there's no server-side session state
 * to leak between agents or requests.
 *
 * Auth is the same agent API key /api/agent/* already accepts — see
 * mcp-server.ts and DECISIONS.md for why this isn't OAuth 2.1.
 */

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

async function handle(req: NextRequest): Promise<Response> {
  const agent = await authenticateAgent(extractBearerKey(req.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json({ error: "invalid or missing agent API key" }, { status: 401 });
  }

  const rateLimit = checkRateLimit(`mcp:${agent.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const server = createMcpServerForAgent(agent);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function DELETE(req: NextRequest) {
  return handle(req);
}
