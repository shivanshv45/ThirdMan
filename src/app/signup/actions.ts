"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { hashPassword, createSession } from "@/lib/auth";
import { logAuditEntry } from "@/lib/audit";

const signupSchema = z.object({
  name: z.string().trim().min(1, "Business name is required"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function signup(formData: FormData) {
  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect(`/signup?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  }

  const { name, email, password } = parsed.data;

  const [existing] = await db.select().from(schema.merchants).where(eq(schema.merchants.email, email));
  if (existing) {
    redirect(`/signup?error=${encodeURIComponent("An account with that email already exists.")}`);
  }

  const passwordHash = await hashPassword(password);

  const [merchant] = await db
    .insert(schema.merchants)
    .values({ name, email, passwordHash })
    .returning();

  await logAuditEntry({
    merchantId: merchant.id,
    actor: "merchant",
    event: "merchant_signed_up",
    decision: "n/a",
    reason: `New merchant account created for "${name}".`,
  });

  await createSession(merchant.id);
  redirect("/dashboard");
}
