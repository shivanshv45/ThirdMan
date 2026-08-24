"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { verifyPassword, createSession } from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const GENERIC_ERROR = "Incorrect email or password.";

export async function login(formData: FormData) {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect(`/login?error=${encodeURIComponent(GENERIC_ERROR)}`);
  }

  const { email, password } = parsed.data;

  const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.email, email));

  // Same generic message whether the email doesn't exist or the password
  // is wrong, so a login attempt can't be used to enumerate accounts.
  if (!merchant || !(await verifyPassword(password, merchant.passwordHash))) {
    redirect(`/login?error=${encodeURIComponent(GENERIC_ERROR)}`);
  }

  await createSession(merchant.id);
  redirect("/dashboard");
}
