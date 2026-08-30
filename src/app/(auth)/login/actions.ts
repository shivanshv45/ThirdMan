"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { verifyPassword, createSession } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { checkLoginThrottle, recordLoginFailure, clearLoginThrottle, FREE_ATTEMPTS } from "@/lib/login-throttle";
import { logAuditEntry } from "@/lib/audit";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const GENERIC_ERROR = "Incorrect email or password.";
const TOO_MANY_ATTEMPTS_ERROR = "Too many attempts. Please wait a minute and try again.";
const THROTTLED_ERROR = "Too many attempts on this account. Please wait a moment and try again.";

// Keyed by client IP, via next/headers' own headers() — Server Actions
// don't get a request object the way route handlers do, but the
// underlying request headers are still readable this way. This guards
// against one source hammering the login form generally.
//
// This used to be keyed by the attempted email instead. That was a real
// bug this same layer's own security-review pass (L26-6) caught: a
// per-EMAIL rate limit with no IP dimension is exactly the lockout this
// layer's login-throttle.ts was explicitly designed NOT to be (see
// L26-3's "no lockout" reasoning) — an attacker who knows a merchant's
// email could hold this bucket saturated indefinitely, denying that
// merchant's own correct-password attempts for as long as the attack
// continued, with no AUTH_THROTTLE_EXEMPT_EMAILS escape hatch (that
// allowlist only covers login-throttle.ts's own account-keyed backoff
// below). Keying this one by IP instead makes it what it always should
// have been: a burst guard on one source, not a lever on one victim.
// login-throttle.ts's per-account exponential backoff is the
// distributed-attacker-shaped guard (many IPs, one account) and stays
// account-keyed — see plans/layer-26-hardening.md's L26-3 for why both
// exist and why only the account-keyed one honors the exempt-email list.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// A fixed dummy hash to compare against when no merchant matches the
// email, so the not-found branch pays the same scrypt cost as the
// found-but-wrong-password branch (Layer 26-3: password.ts's own
// verifyPassword already spends real, non-trivial time here). Without
// this, an unauthenticated caller could distinguish "no such account"
// from "wrong password" by response timing alone. Never a real
// credential — scrypt(anything, this salt) with no matching account.
const DUMMY_HASH = "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

/**
 * The constant-time-by-construction half of login, pulled out so it's
 * directly testable (measured, not asserted by inspection — Layer
 * 26-7) without fighting the Server Action's redirect() calls. Always
 * runs a real scrypt comparison — against the account's real hash when
 * one exists, against the fixed dummy hash otherwise — so a caller
 * cannot tell "no such account" from "wrong password" by response
 * timing. password.ts's own timingSafeEqual/length-mismatch discipline
 * is unchanged; this is the same care applied one level up.
 */
export async function verifyLoginCredentials(email: string, password: string): Promise<{ valid: boolean; merchant: typeof schema.merchants.$inferSelect | undefined }> {
  const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.email, email));
  const hashToCompare = merchant?.passwordHash ?? DUMMY_HASH;
  const passwordOk = await verifyPassword(password, hashToCompare);
  const valid = Boolean(merchant?.passwordHash) && passwordOk;
  return { valid, merchant };
}

export async function login(formData: FormData) {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect(`/login?error=${encodeURIComponent(GENERIC_ERROR)}`);
  }

  const { email, password } = parsed.data;

  const clientIp = getClientIp(await headers());
  const rateLimit = await checkRateLimit(`login:${clientIp}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    redirect(`/login?error=${encodeURIComponent(TOO_MANY_ATTEMPTS_ERROR)}`);
  }

  const throttle = await checkLoginThrottle(email);
  if (!throttle.allowed) {
    redirect(`/login?error=${encodeURIComponent(THROTTLED_ERROR)}`);
  }

  const { valid, merchant } = await verifyLoginCredentials(email, password);

  if (!valid) {
    const { failedAttempts } = await recordLoginFailure(email);
    // Only a real, existing account can be audited against (audit_log
    // rows are merchant-scoped) — a burst against an email with no
    // account at all has no merchant to alert, and enumerable-account
    // information belongs nowhere in this response either way. Fires
    // once per burst crossing the free-attempts threshold, not on every
    // subsequent failure — an alert per failed attempt would be exactly
    // the noise merchant-alerts.ts's own digest discipline exists to
    // avoid. Best-effort: a failure here must never turn a login
    // attempt into a 500.
    if (merchant && failedAttempts === FREE_ATTEMPTS + 1) {
      try {
        await logAuditEntry({
          merchantId: merchant.id,
          actor: "system",
          event: "login_burst_flagged",
          decision: "n/a",
          reason: `${failedAttempts} failed login attempts on this account within the decay window.`,
        });
      } catch (err) {
        console.error("[login] failed to log login_burst_flagged:", err);
      }
    }
    redirect(`/login?error=${encodeURIComponent(GENERIC_ERROR)}`);
  }

  await clearLoginThrottle(email);
  await createSession(merchant!.id);
  redirect("/dashboard");
}
