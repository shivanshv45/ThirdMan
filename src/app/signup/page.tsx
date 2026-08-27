import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { signup } from "./actions";
import { Surface, Field, Input, Button, AmbientField } from "@/components/ui";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (merchant) redirect("/dashboard");

  const { error } = await searchParams;

  return (
    <main className="relative isolate overflow-hidden flex-1 flex items-center justify-center px-6 py-16">
      <div className="absolute inset-0 -z-10 bg-ink opacity-40">
        <AmbientField />
      </div>
      <div className="w-full max-w-sm">
        <Link href="/" className="font-[family-name:var(--font-display)] text-xl text-on-ink inline-block mb-8">
          ThirdMan
        </Link>

        <Surface variant="raised" className="p-6">
          <h1 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] font-medium text-on-ink mb-1">
            Create your merchant account
          </h1>
          <p className="text-sm text-on-ink-dim mb-6">
            Sign up, then connect your own Razorpay test account from Settings.
          </p>

          {error && (
            <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2 mb-4">
              {error}
            </p>
          )}

          <form action={signup} className="space-y-4">
            <Field label="Business name">
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" required minLength={8} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" pendingLabel="Creating account…">
              Sign up
            </Button>
          </form>
        </Surface>

        <p className="text-sm text-on-ink-faint mt-5 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-accent hover:text-accent-bright underline underline-offset-2">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
