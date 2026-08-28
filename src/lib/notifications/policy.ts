/**
 * Every bound governing an outbound human-facing notification lives
 * here, and only here — pure functions, no I/O, no model. This is the
 * third instance of this discipline in the codebase (recovery/policy.ts
 * for recovery attempts, webhooks/policy.ts for merchant-server
 * webhooks); see ARCHITECTURE.md's recovery pipeline contract point 3.
 *
 * This is deliberately a SEPARATE policy from webhooks/policy.ts even
 * though the shape rhymes closely: that one notifies a merchant's
 * SERVER (machine-to-machine, HMAC-signed, SSRF is the risk); this one
 * notifies a HUMAN (consent and an anti-spam frequency cap are the
 * risk, no signing needed). Read
 * plans/layer-11-notifications-and-token-rewards.md's L11-2 before
 * changing the backoff schedule or the frequency cap — both are
 * anti-spam bounds, not incidental defaults.
 */

// 5m, 30m, 4h, then exhausted. Slower than webhooks/policy.ts's
// schedule on purpose — a human's inbox is not a server, and hammering
// a provider on a soft bounce burns free-tier quota for no benefit.
const BACKOFF_MINUTES = [5, 30, 240];

export const MAX_NOTIFICATION_ATTEMPTS = BACKOFF_MINUTES.length;

/** The retry schedule. Pure function of attempt number and "now" — same shape as recovery/policy.ts's nextAttemptTime. */
export function nextNotificationAttemptTime(attemptNumber: number, now: Date): Date {
  const index = Math.min(Math.max(attemptNumber - 1, 0), BACKOFF_MINUTES.length - 1);
  return new Date(now.getTime() + BACKOFF_MINUTES[index] * 60 * 1000);
}

/** Whether attemptNumber has exhausted the retry budget — the sender's stopping rule. */
export function hasExhaustedNotificationRetries(attemptNumber: number): boolean {
  return attemptNumber >= MAX_NOTIFICATION_ATTEMPTS;
}

/**
 * Classifies a send outcome as retryable or not. A hard bounce or a
 * rejected address (4xx from the provider) is terminal — retrying a bad
 * address is how a sender's reputation dies. 5xx, a timeout, or a rate
 * limit (429) is the provider's own trouble and worth retrying.
 */
export function isRetryableSendFailure(statusCode: number | null): boolean {
  if (statusCode === null) return true; // timeout / connection error
  if (statusCode === 429) return true;
  return statusCode >= 500;
}

/**
 * The anti-spam bound: at most this many notifications to one contact
 * in a rolling day, enforced deterministically at enqueue time —
 * same shape as recovery/policy.ts's MAX_ATTEMPTS_PER_FAILURE, applied
 * to a human's attention instead of a card. Exceeding it produces a
 * "suppressed" row with this rule named, never a silent drop.
 *
 * Distinct from and orthogonal to recovery/policy.ts's own
 * MAX_ATTEMPTS_PER_FAILURE, which bounds how many times ONE failure is
 * retried (and therefore how many recovery emails it can ever produce).
 * This bound instead covers a person with several unrelated failures,
 * or a restock request plus a recovery email landing the same day. Do
 * not "simplify" by removing one in favor of the other — they cover
 * different cases.
 */
export const MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY = 3;

export function frequencyCapWindowStart(now: Date): Date {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}
