import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { login } from "./actions";
import { Surface, Field, Input, Button, AmbientField } from "@/components/ui";

export default async function LoginPage({
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
          <h1 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] font-medium text-on-ink mb-6">
            Log in
          </h1>

          {error && (
            <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2 mb-4">
              {error}
            </p>
          )}

          <form action={login} className="space-y-4">
            <Field label="Email">
              <Input name="email" type="email" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" required />
            </Field>
            <Button type="submit" variant="primary" className="w-full" pendingLabel="Logging in…">
              Log in
            </Button>
          </form>
        </Surface>

        <p className="text-sm text-on-ink-faint mt-5 text-center">
          No account yet?{" "}
          <Link href="/signup" className="text-accent hover:text-accent-bright underline underline-offset-2">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
