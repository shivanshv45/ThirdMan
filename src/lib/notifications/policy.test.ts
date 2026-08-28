import { describe, it, expect } from "vitest";
import {
  hasExhaustedNotificationRetries,
  isRetryableSendFailure,
  MAX_NOTIFICATION_ATTEMPTS,
  MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY,
  nextNotificationAttemptTime,
  frequencyCapWindowStart,
} from "./policy";

describe("nextNotificationAttemptTime", () => {
  it("follows the documented backoff schedule: 5m, 30m, 4h", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(nextNotificationAttemptTime(1, now).getTime() - now.getTime()).toBe(5 * 60_000);
    expect(nextNotificationAttemptTime(2, now).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(nextNotificationAttemptTime(3, now).getTime() - now.getTime()).toBe(240 * 60_000);
  });

  it("clamps to the last schedule entry beyond the max attempt count", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(nextNotificationAttemptTime(99, now).getTime() - now.getTime()).toBe(240 * 60_000);
  });
});

describe("hasExhaustedNotificationRetries", () => {
  it("is false before the max attempt count and true at/after it", () => {
    expect(hasExhaustedNotificationRetries(MAX_NOTIFICATION_ATTEMPTS - 1)).toBe(false);
    expect(hasExhaustedNotificationRetries(MAX_NOTIFICATION_ATTEMPTS)).toBe(true);
    expect(hasExhaustedNotificationRetries(MAX_NOTIFICATION_ATTEMPTS + 1)).toBe(true);
  });
});

describe("isRetryableSendFailure", () => {
  it("retries on 5xx, 429, and no status code (timeout/connection failure)", () => {
    expect(isRetryableSendFailure(500)).toBe(true);
    expect(isRetryableSendFailure(503)).toBe(true);
    expect(isRetryableSendFailure(429)).toBe(true);
    expect(isRetryableSendFailure(null)).toBe(true);
  });

  it("does not retry on other 4xx or 2xx", () => {
    expect(isRetryableSendFailure(400)).toBe(false);
    expect(isRetryableSendFailure(404)).toBe(false);
    expect(isRetryableSendFailure(200)).toBe(false);
  });
});

describe("frequencyCapWindowStart", () => {
  it("is exactly 24 hours before now", () => {
    const now = new Date("2026-01-02T12:00:00Z");
    expect(now.getTime() - frequencyCapWindowStart(now).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY", () => {
  it("is a positive integer bound", () => {
    expect(Number.isInteger(MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY)).toBe(true);
    expect(MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY).toBeGreaterThan(0);
  });
});
