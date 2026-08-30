import { MCPToolset, type StreamableHTTPConnectionParams } from "@google/adk/tools/mcp";
import { env } from "./env";

/**
 * Connects to the merchant platform's existing MCP endpoint over
 * Streamable HTTP, authenticating with the same Authorization: Bearer
 * scheme every agent integration uses (agent-auth.ts's contract, on the
 * other side of this connection). Tools are discovered at runtime via
 * the MCP handshake — never hardcoded — so this client can never drift
 * from the server's own contract.
 */
export function createBuyerToolset(): MCPToolset {
  const connectionParams: StreamableHTTPConnectionParams = {
    type: "StreamableHTTPConnectionParams",
    url: new URL("/api/mcp", env.THIRDMAN_BASE_URL).toString(),
    transportOptions: {
      requestInit: {
        headers: { Authorization: `Bearer ${env.THIRDMAN_AGENT_KEY}` },
      },
    },
  };
  return new MCPToolset(connectionParams);
}
