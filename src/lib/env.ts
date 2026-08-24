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
