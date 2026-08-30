import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * Layer 26-4/26-7: security headers present on every response class.
 * next.config.ts's headers() is a pure function of route patterns (no
 * request, no DB) — calling it directly proves what actually ships
 * without needing a running server. The embed route's own
 * frame-ancestors composition is proved separately in
 * embed-headers-compose.test.ts against the real proxy() function.
 */

async function getHeaderRules() {
  if (!nextConfig.headers) throw new Error("next.config.ts has no headers() function");
  return nextConfig.headers();
}

function findRule(rules: Awaited<ReturnType<typeof getHeaderRules>>, source: string) {
  return rules.find((r) => r.source === source);
}

function headerValue(rule: { headers: Array<{ key: string; value: string }> } | undefined, key: string): string | undefined {
  return rule?.headers.find((h) => h.key === key)?.value;
}

describe("next.config.ts security headers", () => {
  it("applies nosniff, Referrer-Policy, and HSTS globally", async () => {
    const rules = await getHeaderRules();
    const globalRule = findRule(rules, "/:path*");
    expect(headerValue(globalRule, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(globalRule, "Referrer-Policy")).toBeTruthy();
    expect(headerValue(globalRule, "Strict-Transport-Security")).toMatch(/max-age=\d+/);
  });

  it("applies a real CSP to the dashboard, login, signup, and store, each denying framing by default", async () => {
    const rules = await getHeaderRules();
    for (const source of ["/dashboard/:path*", "/login", "/signup", "/store/:path*"]) {
      const rule = findRule(rules, source);
      const csp = headerValue(rule, "Content-Security-Policy");
      expect(csp, `expected a CSP on ${source}`).toBeTruthy();
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  it("allows Razorpay Checkout's script and iframe origins on the dashboard/store CSP", async () => {
    const rules = await getHeaderRules();
    const dashboardCsp = headerValue(findRule(rules, "/dashboard/:path*"), "Content-Security-Policy");
    expect(dashboardCsp).toContain("checkout.razorpay.com");
  });

  it("defines no static CSP rule matching /embed — that route's CSP comes from proxy.ts alone", async () => {
    const rules = await getHeaderRules();
    const embedRule = rules.find((r) => r.source.startsWith("/embed"));
    expect(embedRule).toBeUndefined();
  });
});
