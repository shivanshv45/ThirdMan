import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { isProviderConfigured } from "@/lib/oauth";
import { login } from "./actions";

function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18A14.5 14.5 0 0 1 10.93 24c0-1.45.25-2.87.76-4.18v-5.7H4.34A21.98 21.98 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

function GithubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.5 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.36-3.37-1.36-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 2.5-.35c.85 0 1.71.12 2.5.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.81 0 .28.18.61.69.5A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

export default async function LoginPage({
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
    <div className="relative z-10 w-full max-w-[480px] flex flex-col items-center">
      {/* ── Card ── */}
      {/* Heading */}
      <h1 className="text-[26px] font-semibold tracking-tight mb-2 text-white text-center">
        Log in to ThirdMan
      </h1>
      <p className="text-[15px] mb-10 text-center" style={{ color: "#888" }}>
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium transition-opacity hover:opacity-80 underline underline-offset-4 decoration-[#666]" style={{ color: "#fff" }}>
          Sign up.
        </Link>
      </p>

      {/* Frosted glass form container */}
      <div
        className="w-full rounded-2xl p-8"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
        }}
      >
        {error && (
          <p
            className="w-full text-[13px] text-center rounded-xl px-4 py-2.5 mb-6"
            style={{ color: "#f87171", background: "rgba(127,29,29,0.35)", border: "1px solid #7f1d1d" }}
          >
            {error}
          </p>
        )}

        {/* OAuth row */}
        {(googleEnabled || githubEnabled) && (
          <>
            <div className="w-full grid grid-cols-2 gap-3 mb-0">
              {googleEnabled && (
                <a
                  href="/api/auth/google/start"
                  className="flex items-center justify-center gap-2.5 h-[48px] rounded-xl text-[13.5px] font-medium transition-all duration-200 hover:brightness-125"
                  style={{ background: "#161616", border: "1px solid #2a2a2a", color: "#ededed" }}
                >
                  <GoogleMark />
                  Log in with Google
                </a>
              )}
              {githubEnabled && (
                <a
                  href="/api/auth/github/start"
                  className="flex items-center justify-center gap-2.5 h-[48px] rounded-xl text-[13.5px] font-medium transition-all duration-200 hover:brightness-125"
                  style={{ background: "#161616", border: "1px solid #2a2a2a", color: "#ededed" }}
                >
                  <GithubMark />
                  Log in with GitHub
                </a>
              )}
            </div>

            {/* Divider */}
            <div className="w-full flex items-center gap-4 my-7">
              <span className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
              <span className="text-[12px] uppercase tracking-widest" style={{ color: "#555" }}>or</span>
              <span className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
            </div>
          </>
        )}

        {/* Form */}
        <form action={login} className="w-full space-y-5">
          {/* Email */}
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium tracking-wide" style={{ color: "#aaa" }}>Email</label>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="third.man@example.com"
              className="w-full h-[48px] rounded-xl px-4 text-[15px] outline-none transition-all duration-200"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "#ededed",
                boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
              }}
            />
          </div>

          {/* Password */}
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium tracking-wide" style={{ color: "#aaa" }}>Password</label>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full h-[48px] rounded-xl px-4 text-[15px] outline-none transition-all duration-200"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "#ededed",
                boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
              }}
            />
          </div>

          {/* Submit */}
          <div className="pt-1">
            <button
              type="submit"
              className="w-full h-[48px] rounded-xl text-[15px] font-semibold transition-all duration-200 cursor-pointer hover:brightness-110"
              style={{
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "#888",
                boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
              }}
            >
              Log in
            </button>
          </div>
        </form>
      </div>

      {/* Footer */}
      <p className="text-[12px] mt-8 text-center" style={{ color: "#555" }}>
        By signing in, you agree to our{" "}
        <Link href="#" className="underline" style={{ color: "#777" }}>Terms</Link>
        {" "}and{" "}
        <Link href="#" className="underline" style={{ color: "#777" }}>Privacy Policy</Link>.
      </p>
    </div>
  );
}
