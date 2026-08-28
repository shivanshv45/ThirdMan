import { env } from "@/lib/env";

/**
 * The only sanctioned way to send a customer/merchant-facing email in
 * this codebase — feature code never calls Resend's API or any other
 * provider directly, same "one shared wrapper module" discipline
 * CLAUDE.md's LLM provider policy requires of llm.ts.
 *
 * Provider: Resend. Free tier (3,000/month, 100/day) needs no domain
 * verification — it sends from a shared onboarding@resend.dev address —
 * which is what makes it usable without the merchant owning a domain.
 * See DECISIONS.md.
 *
 * When RESEND_API_KEY is absent, every call falls back to a console-log
 * provider. This is NOT a mock: it is a real, honest degradation that
 * still exercises the queue, the retry policy, and the audit trail —
 * the only thing that doesn't happen is a real inbox receiving mail.
 * Callers must record which provider served a send (see
 * notifications/send.ts) and the UI must never present a console-only
 * send as "delivered to the customer."
 */

const SEND_TIMEOUT_MS = 10_000;
const CONSOLE_FALLBACK_FROM = "onboarding@resend.dev";

export type EmailProviderName = "resend" | "console";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  unsubscribeUrl: string;
}

export interface SendResult {
  ok: boolean;
  provider: EmailProviderName;
  providerMessageId?: string;
  statusCode: number | null;
  error?: string;
}

async function sendViaResend(input: SendEmailInput): Promise<SendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: CONSOLE_FALLBACK_FROM,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: {
          "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const statusCode = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, provider: "resend", statusCode, error: body.slice(0, 500) || `Resend returned ${statusCode}` };
    }

    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, provider: "resend", statusCode, providerMessageId: body.id };
  } catch (err) {
    // Network failure, DNS failure, or the AbortSignal firing — no
    // status code at all, treated as retryable by
    // notifications/policy.ts's isRetryableSendFailure(null).
    return { ok: false, provider: "resend", statusCode: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendViaConsole(input: SendEmailInput): Promise<SendResult> {
  console.log(
    `[notifications] (console fallback — no RESEND_API_KEY configured, nothing was actually delivered)\n` +
      `  to: ${input.to}\n  subject: ${input.subject}\n  unsubscribe: ${input.unsubscribeUrl}\n  body:\n${input.text}`,
  );
  return { ok: true, provider: "console", statusCode: 200, providerMessageId: `console-${Date.now()}` };
}

/** Sends one email through whichever provider is configured, chosen explicitly and recorded on the result — never silently assumed. */
export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return sendViaConsole(input);
  return sendViaResend(input);
}
