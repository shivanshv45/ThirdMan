/**
 * L20-6: the CLI's half of account linking — redeems a merchant-pasted
 * token from POST /api/cli/link. See src/lib/cli-link.ts on the app
 * side for what the token actually grants (one agent key, one origin
 * allowlist add — never a session, never a password).
 */
export async function redeemLinkToken(appOrigin, token, agentName, origin) {
    let res;
    try {
        res = await fetch(`${appOrigin}/api/cli/link`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, agentName, origin }),
        });
    }
    catch (err) {
        return { ok: false, error: `Could not reach ${appOrigin}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const body = (await res.json().catch(() => ({})));
    if (!res.ok) {
        return { ok: false, error: typeof body.error === "string" ? body.error : `Link failed with HTTP ${res.status}` };
    }
    return { ok: true, result: body };
}
//# sourceMappingURL=link.js.map