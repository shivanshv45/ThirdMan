"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { verifyPassword, createSession } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const GENERIC_ERROR = "Incorrect email or password.";
const TOO_MANY_ATTEMPTS_ERROR = "Too many attempts. Please wait a minute and try again.";

// Keyed by the attempted email, not IP — Server Actions don't get a
// request object to read a client IP from the same way route handlers
// do, and limiting by the targeted account is a reasonable guard
// against credential stuffing on one email regardless of source IP.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function login(formData: FormData) {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect(`/login?error=${encodeURIComponent(GENERIC_ERROR)}`);
  }

  const { email, password } = parsed.data;

  const rateLimit = checkRateLimit(`login:${email}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    redirect(`/login?error=${encodeURIComponent(TOO_MANY_ATTEMPTS_ERROR)}`);
  }

  const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.email, email));

  // Same generic message whether the email doesn't exist or the password
  // is wrong, so a login attempt can't be used to enumerate accounts.
  if (!merchant || !(await verifyPassword(password, merchant.passwordHash))) {
    redirect(`/login?error=${encodeURIComponent(GENERIC_ERROR)}`);
  }

  await createSession(merchant.id);
  redirect("/dashboard");
}
