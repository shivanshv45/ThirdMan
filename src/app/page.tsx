import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";

export default async function Home() {
  const merchant = await getSessionMerchant();
  if (merchant) redirect("/dashboard");

  return (
    <main className="flex-1">
      <div className="max-w-3xl mx-auto px-6 py-24">
        <p className="text-sm text-gray-500 mb-3">For Razorpay merchants</p>
        <h1 className="text-4xl font-semibold tracking-tight mb-4">
          Let AI agents buy from your store — without letting them spend past what you allow.
        </h1>
        <p className="text-lg text-gray-600 mb-8">
          Connect your Razorpay account, set a spend cap per agent, and every purchase an AI buyer
          makes is checked against that cap before a rupee moves. Every allow, deny, and escalation
          is written to an audit trail you can read in plain English. When a payment fails, a
          bounded recovery pipeline tries to get it back — and stops itself when it isn&apos;t worth
          chasing anymore.
        </p>

        <div className="flex gap-3 mb-16">
          <Link
            href="/signup"
            className="px-5 py-2.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700"
          >
            Sign up free
          </Link>
          <Link
            href="/login"
            className="px-5 py-2.5 rounded border font-medium hover:bg-gray-50"
          >
            Log in
          </Link>
        </div>

        <div className="grid sm:grid-cols-3 gap-8 border-t pt-10">
          <div>
            <h2 className="font-semibold mb-1">Bounded spend</h2>
            <p className="text-sm text-gray-600">
              Every agent gets a cap, a per-transaction limit, and a time window. A purchase over
              the limit is denied before any money moves — arithmetic, not a model guessing.
            </p>
          </div>
          <div>
            <h2 className="font-semibold mb-1">A real audit trail</h2>
            <p className="text-sm text-gray-600">
              Every decision — allowed, denied, or escalated — is logged with the reason why, in a
              sentence a merchant can actually read, not a status code.
            </p>
          </div>
          <div>
            <h2 className="font-semibold mb-1">Automatic recovery</h2>
            <p className="text-sm text-gray-600">
              Failed payments are diagnosed, retried within deterministic limits, and written off
              when they aren&apos;t worth chasing — bounded by the same spend caps as everything else.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
