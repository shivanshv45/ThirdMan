import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionMerchant } from "@/lib/auth";
import { getAgentReadiness } from "@/lib/agent-readiness";
import { getProducts } from "@/lib/dashboard";
import { SuggestDescription } from "./suggest-description";

const MIN_DESCRIPTION_LENGTH = 20;

export default async function ReadinessPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [report, products] = await Promise.all([getAgentReadiness(merchant.id), getProducts(merchant.id)]);

  const thinProducts = products.filter((p) => p.status === "active" && p.description.trim().length < MIN_DESCRIPTION_LENGTH);

  const scoreColor = report.score >= 80 ? "text-green-700" : report.score >= 50 ? "text-amber-700" : "text-red-700";

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Agent readiness</h1>
        <p className="text-sm text-gray-500">
          A deterministic checklist over your real data — not a vanity score. Every item below is a real, named check; none of it is decided by a model.
        </p>
      </header>

      <section className="border rounded-lg p-6 text-center">
        <p className={`text-5xl font-bold ${scoreColor}`}>{report.score}%</p>
        <p className="text-sm text-gray-500 mt-1">Agent readiness score</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Checklist</h2>
        {report.checks.map((check) => (
          <div key={check.id} className={`border rounded-lg p-3 flex items-start gap-3 ${check.passed ? "" : "bg-red-50 border-red-200"}`}>
            <span className={check.passed ? "text-green-600" : "text-red-600"}>{check.passed ? "✓" : "✗"}</span>
            <div className="flex-1">
              <p className="text-sm font-medium">
                {check.label} <span className="text-xs text-gray-400">(weight {check.weight})</span>
              </p>
              {check.fix && (
                <p className="text-xs text-gray-600 mt-1">
                  {check.fix.message}{" "}
                  <Link href={check.fix.href} className="text-blue-700 underline">
                    Fix it
                  </Link>
                </p>
              )}
            </div>
          </div>
        ))}
      </section>

      {thinProducts.length > 0 && (
        <section className="border rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-1">Description suggestions</h2>
          <p className="text-sm text-gray-500 mb-3">
            {thinProducts.length} product(s) have a thin or missing description. A model can draft one from the product&apos;s real name/category/attributes — you review and save it, nothing is written automatically.
          </p>
          <div className="space-y-2">
            {thinProducts.map((p) => (
              <div key={p.id}>
                <SuggestDescription productId={p.id} productName={p.name} />
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
