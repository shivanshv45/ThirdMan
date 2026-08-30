import { PageHeader } from "@/components/ui";
import { AuditForm } from "./audit-form";

/**
 * Layer 24-1: the Instant Audit. Public, no signup, no install — paste a
 * store URL, get a real agent-readiness report against real fetched
 * pages. See src/lib/store-audit.ts for the orchestration and
 * src/lib/store-checks.ts for the checks themselves; this route only
 * renders what those return.
 */
export default function InstantAuditPage() {
  return (
    <div className="coda-theme min-h-screen bg-ink">
      <div className="max-w-[var(--shell)] mx-auto px-4 md:px-8 py-10 md:py-16 space-y-8">
        <PageHeader
          title="Instant Audit"
          description="Paste any storefront URL. In about thirty seconds you get an honest, evidence-based readiness report — can an AI buyer actually find, read, and purchase from this store today."
        />
        <AuditForm />
      </div>
    </div>
  );
}
