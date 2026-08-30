/**
 * L20-6: the CLI's half of account linking — redeems a merchant-pasted
 * token from POST /api/cli/link. See src/lib/cli-link.ts on the app
 * side for what the token actually grants (one agent key, one origin
 * allowlist add — never a session, never a password).
 */

export interface CliLinkResponse {
  merchantId: string;
  merchantName: string;
  agentId: string;
  agentName: string;
  apiKey: string;
}

export async function redeemLinkToken(
  appOrigin: string,
  token: string,
  agentName: string,
  origin: string | null,
): Promise<{ ok: true; result: CliLinkResponse } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${appOrigin}/api/cli/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, agentName, origin }),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach ${appOrigin}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return { ok: false, error: typeof body.error === "string" ? body.error : `Link failed with HTTP ${res.status}` };
  }

  return { ok: true, result: body as unknown as CliLinkResponse };
}
