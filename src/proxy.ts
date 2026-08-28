import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveEmbedKey } from "@/lib/embed";

/**
 * Auth redirect: an optimistic cookie-presence check only — checks
 * whether the session cookie is present, not whether it's valid. This
 * part must stay a cheap cookie read, never a DB call, since it runs on
 * every prefetched /dashboard|/login|/signup request. The real check
 * (session exists, hasn't expired) happens in the page itself via
 * getSessionMerchant()/requireSessionMerchant() in src/lib/auth.ts.
 *
 * The /embed/[publishableKey] branch below is different: this Next.js
 * version's proxy defaults to the Node.js runtime (not Edge-only), so a
 * real DB lookup here is supported — and it has to happen here, not in
 * the page, because next/headers' headers() is READ-ONLY inside a
 * Server Component; setting an outgoing response header requires
 * NextResponse, which only proxy/route handlers can return. This is
 * Layer 10-2's frame-ancestors CSP: the browser-enforced half of the
 * embed's origin allowlist (see embed-cors.ts for the server-enforced
 * half, which applies to every API call regardless of what loads the
 * iframe). An unknown or misconfigured key/merchant fails closed to
 * frame-ancestors 'none' — never omitted, which would leave the
 * iframe embeddable everywhere while its key resolution is broken.
 */

const SESSION_COOKIE = "session_id";
const protectedPrefixes = ["/dashboard"];
const authPages = ["/login", "/signup"];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  const embedMatch = path.match(/^\/embed\/([^/]+)/);
  if (embedMatch) {
    return applyEmbedCsp(request, embedMatch[1]);
  }

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (protectedPrefixes.some((p) => path.startsWith(p)) && !hasSessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (authPages.includes(path) && hasSessionCookie) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

async function applyEmbedCsp(request: NextRequest, publishableKey: string): Promise<NextResponse> {
  const response = NextResponse.next();

  // resolveEmbedKey already returns null for an unknown key or a
  // disabled embed — the same uniform "not usable" signal every other
  // caller of it relies on.
  const config = await resolveEmbedKey(publishableKey);
  const allowedOrigins = config?.allowedOrigins ?? [];

  // Fail closed: no config or an empty allowlist both mean nobody is
  // allowed to frame this page — never fall through to omitting the
  // header, which browsers treat as "no restriction".
  const frameAncestors = allowedOrigins.length > 0 ? allowedOrigins.join(" ") : "'none'";

  response.headers.set("Content-Security-Policy", `frame-ancestors ${frameAncestors};`);
  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/login", "/signup", "/embed/:path*"],
};
