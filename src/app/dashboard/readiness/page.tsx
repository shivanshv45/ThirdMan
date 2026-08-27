import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionMerchant } from "@/lib/auth";
import { getAgentReadiness } from "@/lib/agent-readiness";
import { getProducts } from "@/lib/dashboard";
import { SuggestDescription } from "./suggest-description";
import { PageHeader, Surface, ReadinessGauge } from "@/components/ui";

const MIN_DESCRIPTION_LENGTH = 20;

export default async function ReadinessPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const [report, products] = await Promise.all([getAgentReadiness(merchant.id), getProducts(merchant.id)]);

  const thinProducts = products.filter((p) => p.status === "active" && p.description.trim().length < MIN_DESCRIPTION_LENGTH);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Agent readiness"
        description="A deterministic checklist over your real data — not a vanity score. Every item below is a real, named check; none of it is decided by a model."
      />

      <Surface variant="raised" className="p-8 flex justify-center">
        <ReadinessGauge score={report.score} />
      </Surface>

      <section className="space-y-2.5">
        <h2 className="text-[var(--t-h3)] font-[family-name:var(--font-display)] text-on-ink mb-2">Checklist</h2>
        {report.checks.map((check) => (
          <Surface
            key={check.id}
            variant={check.passed ? "raised" : "flush"}
            className={`p-3.5 flex items-start gap-3 ${!check.passed ? "border-deny-line" : ""}`}
          >
            <CheckMark passed={check.passed} />
            <div className="flex-1">
              <p className="text-sm font-medium text-on-ink">
                {check.label} <span className="text-xs text-on-ink-faint font-mono">(weight {check.weight})</span>
              </p>
              {check.fix && (
                <p className="text-xs text-on-ink-dim mt-1">
                  {check.fix.message}{" "}
                  <Link href={check.fix.href} className="text-accent hover:text-accent-bright underline underline-offset-2">
                    Fix it
                  </Link>
                </p>
              )}
            </div>
          </Surface>
        ))}
      </section>

      {thinProducts.length > 0 && (
        <Surface variant="raised" className="p-5">
          <h2 className="text-[var(--t-h4)] font-medium text-on-ink mb-1">Description suggestions</h2>
          <p className="text-sm text-on-ink-dim mb-3 max-w-[var(--measure)]">
            {thinProducts.length} product(s) have a thin or missing description. A model can draft one from the product&apos;s real name/category/attributes — you review and save it, nothing is written automatically.
          </p>
          <div className="space-y-2">
            {thinProducts.map((p) => (
              <div key={p.id}>
                <SuggestDescription productId={p.id} productName={p.name} />
              </div>
            ))}
          </div>
        </Surface>
      )}
    </div>
  );
}

function CheckMark({ passed }: { passed: boolean }) {
  return (
    <span
      className={`flex items-center justify-center h-5 w-5 rounded-full shrink-0 mt-0.5 ${
        passed ? "bg-allow-wash" : "bg-deny-wash"
      }`}
      aria-hidden="true"
    >
      {passed ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5.2 4 7.7 8.5 2.5" stroke="var(--allow-bright)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2 L8 8 M8 2 L2 8" stroke="var(--deny-bright)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
