import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getAgentsWithCaps } from "@/lib/dashboard";
import { PreflightForm } from "./preflight-form";
import { PageHeader } from "@/components/ui";

/**
 * Layer 13-5: the merchant-facing preflight simulator. "What happens if
 * this agent tries ₹15,000?" answered by the real gate — capability
 * check, Guardian state, spend cap, stock, price match — with nothing
 * executed or reserved regardless of the outcome.
 */
export default async function PreflightPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const agents = await getAgentsWithCaps(merchant.id);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Preflight"
        description="Simulate a purchase before an agent ever tries it. This runs through the real gate — the same capability check, Guardian state, spend cap, and stock checks a real attempt would hit — and stops before anything is reserved or executed. Useful for testing a cap change, or showing exactly why an agent would be refused."
      />

      <PreflightForm agents={agents.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }))} />
    </div>
  );
}
