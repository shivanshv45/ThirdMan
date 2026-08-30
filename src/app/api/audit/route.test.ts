import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

/**
 * L24-1's public endpoint. store-audit.test.ts already covers
 * runInstantAudit's own scoring logic against a real local server; this
 * covers the route's own concerns — request validation and the rate
 * limit, matching cli/link/route.test.ts's division of labor.
 */

function req(body: unknown, ip = `3.0.0.${Math.floor(Math.random() * 250)}`) {
  return new NextRequest("http://localhost/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/audit", () => {
  it("rejects a non-JSON body, 400", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "3.0.1.1" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing/invalid URL, 400, before any fetch is attempted", async () => {
    const res = await POST(req({ url: "not-a-url" }));
    expect(res.status).toBe(400);
  });

  it("rejects a request with no url field, 400", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("is rate-limited per caller IP — the 6th request in a burst is refused with Retry-After", async () => {
    const ip = `3.0.2.${Math.floor(Math.random() * 250)}`;
    // Each of these still fails validation (400) before the rate limiter
    // would matter for a real audit — but checkRateLimit runs before
    // validation in the route, so the count still accrues per real call.
    for (let i = 0; i < 5; i++) {
      await POST(req({ url: "not-a-url" }, ip));
    }
    const sixth = await POST(req({ url: "not-a-url" }, ip));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
  }, 20_000);
});
