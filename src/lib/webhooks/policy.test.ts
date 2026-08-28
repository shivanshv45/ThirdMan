import { describe, it, expect } from "vitest";
import { hasExhaustedRetries, isRetryableOutcome, MAX_DELIVERY_ATTEMPTS, nextDeliveryAttemptTime, validateWebhookUrl } from "./policy";

describe("nextDeliveryAttemptTime", () => {
  it("follows the documented backoff schedule: 1m, 5m, 30m, 2h, 6h", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(nextDeliveryAttemptTime(1, now).getTime() - now.getTime()).toBe(1 * 60_000);
    expect(nextDeliveryAttemptTime(2, now).getTime() - now.getTime()).toBe(5 * 60_000);
    expect(nextDeliveryAttemptTime(3, now).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(nextDeliveryAttemptTime(4, now).getTime() - now.getTime()).toBe(120 * 60_000);
    expect(nextDeliveryAttemptTime(5, now).getTime() - now.getTime()).toBe(360 * 60_000);
  });

  it("clamps to the last schedule entry beyond the max attempt count", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(nextDeliveryAttemptTime(99, now).getTime() - now.getTime()).toBe(360 * 60_000);
  });
});

describe("hasExhaustedRetries", () => {
  it("is false before the max attempt count and true at/after it", () => {
    expect(hasExhaustedRetries(MAX_DELIVERY_ATTEMPTS - 1)).toBe(false);
    expect(hasExhaustedRetries(MAX_DELIVERY_ATTEMPTS)).toBe(true);
    expect(hasExhaustedRetries(MAX_DELIVERY_ATTEMPTS + 1)).toBe(true);
  });
});

describe("isRetryableOutcome", () => {
  it("retries on 5xx and on no status code (timeout/connection failure)", () => {
    expect(isRetryableOutcome(500)).toBe(true);
    expect(isRetryableOutcome(503)).toBe(true);
    expect(isRetryableOutcome(null)).toBe(true);
  });

  it("does not retry on 4xx or 2xx", () => {
    expect(isRetryableOutcome(400)).toBe(false);
    expect(isRetryableOutcome(404)).toBe(false);
    expect(isRetryableOutcome(429)).toBe(false);
    expect(isRetryableOutcome(200)).toBe(false);
  });
});

describe("validateWebhookUrl", () => {
  it("accepts a public https URL", () => {
    expect(validateWebhookUrl("https://merchant-server.example.com/webhooks", { allowLocalhostHttp: false }).valid).toBe(true);
  });

  it("rejects http in production", () => {
    const result = validateWebhookUrl("http://merchant-server.example.com/webhooks", { allowLocalhostHttp: false });
    expect(result.valid).toBe(false);
  });

  it("allows http://localhost only when explicitly permitted (development)", () => {
    expect(validateWebhookUrl("http://localhost:3001/webhooks", { allowLocalhostHttp: true }).valid).toBe(true);
    expect(validateWebhookUrl("http://localhost:3001/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
  });

  it("rejects private/loopback/link-local IPv4 ranges even over https", () => {
    expect(validateWebhookUrl("https://127.0.0.1/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
    expect(validateWebhookUrl("https://10.0.0.5/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
    expect(validateWebhookUrl("https://192.168.1.1/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
    expect(validateWebhookUrl("https://172.16.0.1/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
    // The cloud metadata endpoint — the classic SSRF target.
    expect(validateWebhookUrl("https://169.254.169.254/latest/meta-data", { allowLocalhostHttp: false }).valid).toBe(false);
  });

  it("rejects a public IPv4 address that merely looks similar to a private range", () => {
    // 172.32.x.x is outside the 172.16.0.0/12 private block (172.16-172.31).
    expect(validateWebhookUrl("https://172.32.0.1/webhooks", { allowLocalhostHttp: false }).valid).toBe(true);
  });

  it("rejects IPv6 loopback and unique-local/link-local ranges", () => {
    expect(validateWebhookUrl("https://[::1]/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
    expect(validateWebhookUrl("https://[fd00::1]/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
    expect(validateWebhookUrl("https://[fe80::1]/webhooks", { allowLocalhostHttp: false }).valid).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(validateWebhookUrl("not a url", { allowLocalhostHttp: false }).valid).toBe(false);
  });
});
