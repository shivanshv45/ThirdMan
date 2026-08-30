import type { NextConfig } from "next";

/**
 * Layer 26-4: the ordinary security header set, which — unlike
 * proxy.ts's per-merchant frame-ancestors CSP for /embed/[key] — was
 * simply absent everywhere else. This is a static, deployment-wide
 * policy (headers() runs at build/route-match time, no DB lookup).
 *
 * Deliberately no route rule here matches /embed/:path* — that route
 * gets only the global securityHeaders below (nosniff/HSTS/
 * Referrer-Policy) plus proxy.ts's own Content-Security-Policy, which
 * carries just frame-ancestors, computed per-merchant from the
 * database. A second, static CSP rule for /embed here would mean two
 * separate CSP header values on the same response — Next.js appends
 * rather than replaces when more than one headers() entry matches, and
 * browsers then read a directive present in more than one of the
 * resulting comma-joined values ambiguously depending on the browser.
 * Keeping /embed's CSP to exactly one source (proxy.ts) is what makes
 * "these two must not fight" (the plan's own words) true by
 * construction rather than by hoping the merge behaves. Verified
 * directly: embed-headers-compose.test.ts confirms /embed's own CSP is
 * frame-ancestors-only and unaffected by this file's dashboardCsp.
 *
 * The dashboard's own CSP allows 'unsafe-inline' for scripts and styles.
 * This is a real, deliberate compromise, not an oversight: Next.js's own
 * app-router hydration payload (the self.__next_f.push(...) inline
 * script every page ships) and Tailwind's inline style attributes both
 * need it, and this stack has no nonce-per-request wiring to thread a
 * script nonce through Server Components without new infrastructure.
 * 'unsafe-inline' does not weaken the header's main real protections
 * here — frame-ancestors (clickjacking) and object-src/base-uri
 * (protocol-level injection surfaces) are unaffected by it, and this is
 * the header that would need it removed for a genuine XSS-hardening
 * pass, which is out of scope for this layer (see DECISIONS.md).
 */

const dashboardCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  // This app is never itself framed outside the one deliberate exception
  // (proxy.ts's /embed/[key] route, which overrides this directive with
  // its own per-merchant allowlist) — deny by default everywhere else.
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Only meaningful once actually served over HTTPS (Vercel/Cloud Run
  // both terminate TLS in front of this app) — harmless on plain HTTP
  // dev, where browsers simply ignore it.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // The agent API and MCP endpoint are headless — no browser
        // renders their responses, so a CSP there governs nothing real,
        // but the other headers (nosniff, HSTS, Referrer-Policy) are
        // cheap and correct to apply uniformly rather than special-cased
        // away for one surface.
        source: "/dashboard/:path*",
        headers: [{ key: "Content-Security-Policy", value: dashboardCsp }],
      },
      {
        source: "/login",
        headers: [{ key: "Content-Security-Policy", value: dashboardCsp }],
      },
      {
        source: "/signup",
        headers: [{ key: "Content-Security-Policy", value: dashboardCsp }],
      },
      {
        // The public storefront also runs Razorpay Checkout and needs
        // the same script/style/connect allowances as the dashboard.
        // It is its own standalone page, not an iframe target — only
        // /embed/[publishableKey] is meant to be framed, and that
        // route's frame-ancestors is computed per-merchant in proxy.ts,
        // not here — so /store keeps this file's default deny.
        source: "/store/:path*",
        headers: [{ key: "Content-Security-Policy", value: dashboardCsp }],
      },
    ];
  },
};

export default nextConfig;
