import { notFound } from "next/navigation";
import { resolveEmbedKey } from "@/lib/embed";
import { getMerchantStorefrontInfo } from "@/lib/storefront-catalogue";
import { ChatWidget } from "@/app/store/[merchantId]/chat-widget";

/**
 * The iframe document the loader script (/api/embed/v1.js) points at —
 * Layer 10-2's "cross-origin iframe, not DOM injection" decision (see
 * DECISIONS.md and ARCHITECTURE.md's "The embeddable widget"). Renders
 * the exact same ChatWidget /store/[merchantId] uses, in "embedded"
 * mode, so the merchant's site gets the real design system and the real
 * Razorpay Checkout flow rather than a second, framework-free
 * reimplementation of both.
 *
 * The `origin` query param is a HINT the loader sends, not authority —
 * the iframe can't reliably read document.referrer in every browser, so
 * this page renders regardless of what that param says. The real
 * enforcement is twofold: the frame-ancestors CSP header below (a
 * browser-enforced boundary against loading in an unlisted parent at
 * all) and, independently, the origin check every API call re-runs
 * server-side (embed-cors.ts), which cannot be forged by page script
 * since the browser sets the Origin header itself.
 */
export default async function EmbedPage({ params }: { params: Promise<{ publishableKey: string }> }) {
  const { publishableKey } = await params;
  const config = await resolveEmbedKey(publishableKey);

  if (!config) {
    return (
      <div className="h-dvh w-full flex items-center justify-center bg-ink px-4">
        <p className="text-sm text-on-ink-faint text-center">
          This chat widget isn&apos;t available right now.
        </p>
      </div>
    );
  }

  const merchant = await getMerchantStorefrontInfo(config.merchantId);
  if (!merchant) notFound();

  if (!merchant.razorpayConnected) {
    return (
      <div className="h-dvh w-full flex items-center justify-center bg-ink px-4">
        <p className="text-sm text-on-ink-faint text-center">
          {merchant.name} isn&apos;t accepting payments right now.
        </p>
      </div>
    );
  }

  return (
    <div className="h-dvh w-full bg-ink">
      <ChatWidget
        merchantId={config.merchantId}
        variant="embedded"
        embedKey={publishableKey}
        displayName={config.displayName}
        greeting={config.greeting}
        accentColor={config.accentColor}
      />
    </div>
  );
}
