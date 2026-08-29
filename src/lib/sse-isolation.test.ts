import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/dashboard/decisions/stream/route";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as dashboard from "@/lib/dashboard";

vi.mock("@/lib/auth", () => ({
  getSessionMerchant: vi.fn(),
}));

vi.mock("@/lib/dashboard", () => ({
  getAuditTrail: vi.fn(),
}));

describe("Layer 15 - SSE Isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should return 401 if unauthorized", async () => {
    vi.mocked(auth.getSessionMerchant).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/stream");
    
    const response = await GET(req);
    expect(response.status).toBe(401);
  });

  it("should scope stream events to the exact merchant", async () => {
    const merchantId = "merchant_isolated_123";
    vi.mocked(auth.getSessionMerchant).mockResolvedValue({ id: merchantId } as any);
    
    vi.mocked(dashboard.getAuditTrail).mockResolvedValue([
      { id: "event_1", createdAt: new Date(Date.now() + 1000).toISOString(), merchantId: merchantId, action: "test" } as any
    ]);

    const abortController = new AbortController();
    const req = new NextRequest("http://localhost/api/stream", {
      signal: abortController.signal
    });
    
    const response = await GET(req);
    expect(response.status).toBe(200);

    // Fast-forward so the first tick happens
    await vi.advanceTimersByTimeAsync(2600);

    // Verify it called getAuditTrail exactly with the isolated merchantId
    expect(dashboard.getAuditTrail).toHaveBeenCalledWith(merchantId, 25);
    expect(dashboard.getAuditTrail).toHaveBeenCalledTimes(1);

    // Abort to clean up the interval
    abortController.abort();
  });
});
