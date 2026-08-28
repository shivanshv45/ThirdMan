import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { isProviderConfigured } from "@/lib/oauth";
import { signup } from "./actions";
import { Surface, Field, Input, Button, AuthBackdrop, OAuthButton } from "@/components/ui";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (merchant) redirect("/dashboard");

  const { error } = await searchParams;
  const googleEnabled = isProviderConfigured("google");
  const githubEnabled = isProviderConfigured("github");

  return (
    <main className="relative isolate overflow-hidden flex-1 flex items-center justify-center px-6 py-16">
      <AuthBackdrop />
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <Link
            href="/"
            className="mb-5 flex h-11 w-11 items-center justify-center rounded-[var(--radius-lg)] border border-ink-line bg-ink-raised font-[family-name:var(--font-display)] text-lg text-on-ink"
          >
            T
          </Link>
          <h1 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] font-medium text-on-ink">
            Create your merchant account
          </h1>
          <p className="mt-1.5 text-sm text-on-ink-faint">
            Already have an account?{" "}
            <Link href="/login" className="text-accent hover:text-accent-bright font-medium">
              Log in
            </Link>
            .
          </p>
        </div>

        <Surface variant="raised" className="p-6">
          {error && (
            <p className="text-sm text-deny-bright bg-deny-wash border border-deny-line rounded-[var(--radius)] px-3 py-2 mb-4">
              {error}
            </p>
          )}

          {(googleEnabled || githubEnabled) && (
            <>
              <div className="flex flex-col gap-2.5">
                {googleEnabled && <OAuthButton provider="google" href="/api/auth/google/start" />}
                {githubEnabled && <OAuthButton provider="github" href="/api/auth/github/start" />}
              </div>

              <div className="flex items-center gap-3 my-5">
                <span className="h-px flex-1 bg-ink-line" />
                <span className="text-xs text-on-ink-faint">or</span>
                <span className="h-px flex-1 bg-ink-line" />
              </div>
            </>
          )}

          <form action={signup} className="space-y-4">
            <Field label="Business name">
              <Input name="name" required autoComplete="organization" />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" required autoComplete="email" />
            </Field>
            <Field label="Password" help="At least 8 characters.">
              <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
            </Field>
            <Button type="submit" variant="primary" className="w-full" pendingLabel="Creating account…">
              Sign up
            </Button>
          </form>
        </Surface>

        <p className="text-xs text-on-ink-faint mt-6 text-center">
          Sign up, then connect your own Razorpay test account from Settings.
        </p>
      </div>
    </main>
  );
}
