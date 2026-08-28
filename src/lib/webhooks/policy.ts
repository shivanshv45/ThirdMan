/**
 * Every bound governing an outbound webhook delivery lives here, and
 * only here — pure functions, no I/O, no model, mirroring the split
 * recovery/policy.ts already established for the recovery pipeline
 * (see ARCHITECTURE.md's recovery pipeline contract, point 3: "every
 * bound lives in policy.ts, and only there").
 *
 * Read plans/layer-10-embeddable-commerce.md's L10-5 before changing
 * the retry schedule or the SSRF rules — both are safety-relevant.
 */

// 1m, 5m, 30m, 2h, 6h, then exhausted. Index 0 is the delay before the
// FIRST retry (i.e. after attempt 1 fails), matching
// recovery/policy.ts's nextAttemptTime's own attemptNumber convention.
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];

export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MINUTES.length;

/**
 * The retry schedule. Pure function of attempt number and "now", so
 * it's testable without waiting on a real clock — same shape as
 * recovery/policy.ts's own nextAttemptTime.
 */
export function nextDeliveryAttemptTime(attemptNumber: number, now: Date): Date {
  const index = Math.min(Math.max(attemptNumber - 1, 0), BACKOFF_MINUTES.length - 1);
  return new Date(now.getTime() + BACKOFF_MINUTES[index] * 60 * 1000);
}

/** Whether attemptNumber has exhausted the retry budget — the sequencer's stopping rule. */
export function hasExhaustedRetries(attemptNumber: number): boolean {
  return attemptNumber >= MAX_DELIVERY_ATTEMPTS;
}

/**
 * Classifies an HTTP outcome as retryable or not. 2xx is success
 * (handled by the caller before this is consulted). 4xx means the
 * merchant's endpoint rejected the request — hammering it won't help,
 * so it's terminal. 5xx, a timeout, or a connection failure (no status
 * code at all) is the server's own trouble and worth retrying.
 */
export function isRetryableOutcome(statusCode: number | null): boolean {
  if (statusCode === null) return true; // timeout / connection error / DNS failure
  return statusCode >= 500;
}

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local, incl. cloud metadata)
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
];

function ipv4ToInt(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const parts = match.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return false;
  const asInt = ipv4ToInt(parts);
  return PRIVATE_IPV4_RANGES.some(([start, end]) => asInt >= start && asInt <= end);
}

function isPrivateIPv6(hostname: string): boolean {
  // URL.hostname keeps the [brackets] on an IPv6 literal — strip them
  // before comparing.
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local).
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

export interface WebhookUrlValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a merchant-supplied webhook URL, both at save time and
 * again before every send — this is SSRF prevention for the first time
 * this codebase POSTs to an address a stranger typed into a form. HTTPS
 * only in production; http://localhost is allowed only in development,
 * where it's the normal way to test a receiver.
 */
export function validateWebhookUrl(rawUrl: string, opts: { allowLocalhostHttp: boolean }): WebhookUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "Not a valid URL." };
  }

  const isLocalhostHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (url.protocol !== "https:" && !(opts.allowLocalhostHttp && isLocalhostHttp)) {
    return { valid: false, reason: "Webhook URLs must use https:// (http://localhost is allowed only in development)." };
  }

  if (opts.allowLocalhostHttp && isLocalhostHttp) {
    return { valid: true };
  }

  if (isPrivateIPv4(url.hostname) || isPrivateIPv6(url.hostname)) {
    return { valid: false, reason: "Webhook URLs may not point at a private, loopback, or link-local address." };
  }

  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    return { valid: false, reason: "Webhook URLs may not point at localhost in production." };
  }

  return { valid: true };
}
