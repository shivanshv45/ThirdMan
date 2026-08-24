import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Optimistic auth redirect only — checks whether the session cookie is
 * present, not whether it's valid. Proxy runs on every prefetched route,
 * so it must stay a cheap cookie read, never a DB call. The real check
 * (session exists, hasn't expired) happens in the page itself via
 * getSessionMerchant()/requireSessionMerchant() in src/lib/auth.ts.
 */

const SESSION_COOKIE = "session_id";
const protectedPrefixes = ["/dashboard"];
const authPages = ["/login", "/signup"];

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (protectedPrefixes.some((p) => path.startsWith(p)) && !hasSessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (authPages.includes(path) && hasSessionCookie) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/login", "/signup"],
};
