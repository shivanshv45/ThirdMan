import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const merchant = await getSessionMerchant();
  if (merchant) redirect("/dashboard");

  const { error } = await searchParams;

  return (
    <main className="max-w-sm mx-auto p-6 mt-16">
      <h1 className="text-2xl font-semibold mb-6">Log in</h1>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-4">
          {error}
        </p>
      )}

      <form action={login} className="space-y-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required className="border rounded px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" required className="border rounded px-3 py-2" />
        </label>
        <button type="submit" className="w-full px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
          Log in
        </button>
      </form>

      <p className="text-sm text-gray-500 mt-4">
        No account yet? <a href="/signup" className="text-blue-600 hover:underline">Sign up</a>
      </p>
    </main>
  );
}
