import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForProfile, isProviderConfigured, resolveOrCreateMerchantForOAuth, type OAuthProvider } from "@/lib/oauth";
import { createSession } from "@/lib/auth";

const OAUTH_STATE_COOKIE = "oauth_state";
const GENERIC_ERROR = "Sign-in failed. Please try again.";

function isSupportedProvider(value: string): value is OAuthProvider {
  return value === "google" || value === "github";
}

function fail(req: NextRequest, message = GENERIC_ERROR) {
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, req.url));
}

/**
 * Handles the provider's redirect back with a code. Fail-closed on
 * anything unexpected (bad state, provider error, network failure) —
 * never a 500, always a redirect back to /login with a generic reason,
 * same posture as the password path in src/app/login/actions.ts. The
 * actual sign-in/link/create decision lives in
 * resolveOrCreateMerchantForOAuth (src/lib/oauth.ts) so it's testable
 * without a real provider round-trip.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isSupportedProvider(provider) || !isProviderConfigured(provider)) {
    return fail(req, "That sign-in method isn't available.");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(OAUTH_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return fail(req);
  }

  let profile;
  try {
    profile = await exchangeCodeForProfile(provider, code);
  } catch (err) {
    console.error(`[oauth] ${provider} callback failed:`, err);
    return fail(req);
  }

  const result = await resolveOrCreateMerchantForOAuth(provider, profile);

  if (result.outcome === "email_taken") {
    return fail(req, "An account with that email already exists. Log in with your password instead.");
  }

  await createSession(result.merchantId);
  return NextResponse.redirect(new URL("/dashboard", req.url));
}
