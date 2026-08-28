import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildAuthorizeUrl, isProviderConfigured, type OAuthProvider } from "@/lib/oauth";
import { env } from "@/lib/env";

const OAUTH_STATE_COOKIE = "oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

function isSupportedProvider(value: string): value is OAuthProvider {
  return value === "google" || value === "github";
}

/** Redirects to the provider's own authorize screen. A top-level navigation, not a fetch — OAuth consent screens refuse to render inside anything else. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;

  if (!isSupportedProvider(provider) || !isProviderConfigured(provider)) {
    return NextResponse.redirect(new URL("/login?error=" + encodeURIComponent("That sign-in method isn't available."), _req.url));
  }

  const state = randomBytes(32).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_MS / 1000,
  });

  return NextResponse.redirect(buildAuthorizeUrl(provider, state));
}
