import { z } from "zod";

/**
 * The only place in this codebase allowed to read process.env directly.
 * Everything else imports `env` from here. Fails loudly at import time
 * if a required variable is missing or malformed, not at 2am mid-demo.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  RAZORPAY_KEY_ID: z.string().min(1, "RAZORPAY_KEY_ID is required"),
  RAZORPAY_KEY_SECRET: z.string().min(1, "RAZORPAY_KEY_SECRET is required"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .url("DATABASE_URL must be a valid connection string"),
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  // Layer 16: three more providers, all optional — a provider with no
  // key configured is simply unroutable (model-router.ts's candidate
  // set excludes it), never a crash at import time. Groq/Gemini stay
  // required since existing call sites assume they're always callable.
  NVIDIA_API_KEY: z.string().optional(),
  // NVIDIA NIM's OpenAI-compatible base URL varies by which model/host
  // is provisioned (build.nvidia.com vs. a self-hosted NIM) — required
  // alongside the key, optional as a pair like Google/GitHub OAuth above.
  NVIDIA_ENDPOINT: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  ZAI_API_KEY: z.string().optional(),
  // Shared secret entered into Razorpay's webhook config to match. Consumed
  // by src/lib/webhook-verify.ts since Layer 3.
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1, "RAZORPAY_WEBHOOK_SECRET is required"),
  // AES-256-GCM key for encrypting per-merchant Razorpay credentials at
  // rest — base64, must decode to exactly 32 bytes. Generate with:
  // openssl rand -base64 32
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required")
    .refine((val) => Buffer.from(val, "base64").length === 32, {
      message: "ENCRYPTION_KEY must be base64 decoding to exactly 32 bytes (generate with: openssl rand -base64 32)",
    }),
  // Platform-injected by Vercel's own build environment, not a secret
  // this app configures — optional, used only to resolve the real
  // production domain for social-share image URLs (see layout.tsx).
  VERCEL_URL: z.string().optional(),
  // Layer 11: outbound customer/merchant email. Optional — absent means
  // notifications/provider.ts falls back to a console-log provider, a
  // real (not mocked) degradation that still exercises the whole queue,
  // bounds, and audit trail without a key. See DECISIONS.md.
  RESEND_API_KEY: z.string().optional(),
  // Shared secret for POST /api/cron/run (Layer 11-3) — generate with
  // openssl rand -base64 32. Required in production; optional in
  // development so `npm test`/local dev don't need it configured.
  CRON_SECRET: z.string().optional(),
  // Google/GitHub OAuth (Layer 12). All four optional as a pair — a
  // provider's button is simply hidden on /login and /signup when its
  // pair isn't configured, rather than rendering a button that 500s.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  // Layer 26-3: an operational escape hatch for demo/judge access to
  // skip the per-account login backoff, deliberately never a hardcoded
  // email in source (see plans/layer-26-hardening.md and DECISIONS.md —
  // a hardcoded exempt address is a backdoor in a public repo). Comma-
  // separated, lowercased/trimmed at read time. Optional and empty by
  // default — most deployments need nothing here.
  AUTH_THROTTLE_EXEMPT_EMAILS: z.string().optional(),
  // Layer 24-3: the Shopify app's own credentials, issued by Shopify's
  // Partner Dashboard when the app is created — optional as a pair,
  // same posture as Google/GitHub OAuth above. Absent means
  // shopify.ts's isShopifyConfigured() returns false and the "Connect
  // Shopify" entry point on /dashboard/integrations is simply not
  // rendered, never a button that 500s.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Fix .env.local and restart:\n${problems}`,
    );
  }

  return result.data;
}

export const env = loadEnv();

/**
 * The one place this codebase resolves its own public URL — same
 * reasoning layout.tsx's own siteUrl already documents: no merchant-
 * facing env var names a production domain yet (a wrong hardcoded
 * value would actively break links), so this falls back to localhost
 * in development and picks up Vercel's own build-injected VERCEL_URL
 * automatically once deployed. Used anywhere an absolute URL has to go
 * into an email or a webhook payload — e.g. notifications/send.ts's
 * unsubscribe link, merchant-alerts.ts's digest links.
 */
export function getAppUrl(): string {
  return env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "http://localhost:3000";
}
