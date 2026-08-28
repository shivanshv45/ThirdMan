import { notFound } from "next/navigation";
import Link from "next/link";
import { getMerchantStorefrontInfo } from "@/lib/storefront-catalogue";
import { AiCreditsPanel } from "./ai-credits-panel";

export default async function AiCreditsPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  const merchant = await getMerchantStorefrontInfo(merchantId);
  if (!merchant) notFound();

  return (
    <main className="max-w-2xl mx-auto px-4 md:px-8 py-10 space-y-8">
      <header className="border-b border-ink-line pb-6">
        <Link href={`/store/${merchantId}`} className="text-sm text-on-ink-faint hover:text-on-ink-dim transition-colors">
          ← Back to {merchant.name}
        </Link>
        <h1 className="text-[var(--t-h1)] font-[family-name:var(--font-display)] font-medium text-on-ink tracking-tight mt-2">
          Reward coins
        </h1>
        <p className="text-sm text-on-ink-dim mt-2 max-w-[var(--measure)]">
          Coins earned on purchases at {merchant.name} can be spent on a real AI response, at a price {merchant.name} sets — real model, real answer, no fake balance shown here.
        </p>
      </header>

      <AiCreditsPanel merchantId={merchantId} />
    </main>
  );
}
