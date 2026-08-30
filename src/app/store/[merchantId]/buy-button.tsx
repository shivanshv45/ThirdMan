"use client";

import { useState } from "react";
import { fetchHeaders } from "@/lib/embed-events";

/**
 * The real checkout mechanism (Layer 4-2): Razorpay Checkout, the
 * hosted/embedded JS widget — not a server-side card form, which would
 * take on PCI scope and OTP/3DS handling this project doesn't need to
 * own. The flow: create the order through the gate (server), open
 * Checkout with that order id, then verify the signature Razorpay hands
 * back before treating anything as paid — a client-reported success
 * alone is never trusted (see /api/checkout/verify).
 */

declare global {
  interface Window {
    Razorpay: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  order_id: string;
  handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color: string };
}

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment widget. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

type Status = "idle" | "loading" | "paying" | "verifying" | "success" | "error";

export function BuyButton({
  merchantId,
  productId,
  variantId,
  offerId,
  negotiationId,
  cart,
  sessionToken,
  productName,
  quantity = 1,
  disabled,
  onSuccess,
  embedKey,
  accentColor,
}: {
  merchantId: string;
  /** Exactly one of productId, offerId, negotiationId, or cart — mutually exclusive. */
  productId?: string;
  /** Layer 5-7: when the buyer chat resolved a specific variant, pass it so checkout buys exactly what was in the cart rather than the product's default variant. */
  variantId?: string;
  /** Layer 6-3: buy a previously-accepted bundle offer instead of a single product. Requires sessionToken. */
  offerId?: string;
  /** Layer 8: buy at an agreed negotiated price instead of a single product or a bundle offer. Requires sessionToken. */
  negotiationId?: string;
  /** Layer 9-close-out: buy the buyer chat's real multi-item cart (resolved server-side from sessionToken) instead of a single product/offer/negotiation. Requires sessionToken. */
  cart?: boolean;
  sessionToken?: string;
  productName: string;
  quantity?: number;
  disabled?: boolean;
  onSuccess?: (order: { moneyActionId: string; razorpayOrderId: string; amountPaise: number; productName: string }) => void;
  /** Layer 10: present only when this button is rendered inside the embeddable widget on a third-party origin — see embed-cors.ts. Absent, checkout is unchanged. */
  embedKey?: string;
  /** Layer 10: the merchant's configured accent colour for the Checkout modal's theme, already validated as a hex colour by embed-mutations.ts. Falls back to the platform default. */
  accentColor?: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleBuy() {
    setStatus("loading");
    setMessage(null);

    // One idempotency key per checkout attempt (Layer 26-5) — generated
    // here, not on the server, so a retried fetch (a flaky mobile
    // connection's own retry, or this handler somehow firing twice
    // before `busy` disables the button) carries the SAME key and
    // therefore replays the first attempt's outcome through the gate's
    // existing idempotency mechanism, rather than reserving budget and
    // creating a second Razorpay order. A genuinely new click after this
    // one resolves calls handleBuy again and gets a fresh key.
    const idempotencyKey = crypto.randomUUID();

    try {
      await loadCheckoutScript();

      const orderRes = await fetch("/api/checkout/order", {
        method: "POST",
        headers: fetchHeaders(embedKey),
        body: JSON.stringify({ merchantId, productId, variantId, quantity, offerId, negotiationId, cart, sessionToken, idempotencyKey }),
      });
      const order = await orderRes.json();

      if (!orderRes.ok || order.error) {
        setStatus("error");
        setMessage(order.error ?? "Could not start checkout.");
        return;
      }

      setStatus("paying");

      const razorpay = new window.Razorpay({
        key: order.razorpayKeyId,
        amount: order.amountPaise,
        currency: "INR",
        name: productName,
        order_id: order.razorpayOrderId,
        theme: { color: accentColor ?? "#0d94fb" },
        modal: {
          ondismiss: () => {
            if (status !== "success") {
              setStatus("idle");
              setMessage("Checkout closed.");
            }
          },
        },
        handler: async (response) => {
          setStatus("verifying");
          try {
            const verifyRes = await fetch("/api/checkout/verify", {
              method: "POST",
              headers: fetchHeaders(embedKey),
              body: JSON.stringify({
                moneyActionId: order.moneyActionId,
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            const verify = await verifyRes.json();

            if (verifyRes.ok && verify.decision === "allow") {
              setStatus("success");
              setMessage("Payment confirmed. Thank you!");
              onSuccess?.({
                moneyActionId: order.moneyActionId,
                razorpayOrderId: order.razorpayOrderId,
                amountPaise: order.amountPaise,
                productName,
              });
            } else {
              setStatus("error");
              setMessage(verify.reason ?? verify.error ?? "Payment could not be verified.");
            }
          } catch {
            setStatus("error");
            setMessage("Payment was made, but verification failed to reach the server. It will still be confirmed automatically via webhook.");
          }
        },
      });

      razorpay.open();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (status === "success") {
    return <p className="text-sm text-allow-bright">{message}</p>;
  }

  const busy = status === "loading" || status === "paying" || status === "verifying";

  return (
    <div className="space-y-1.5">
      <button
        onClick={handleBuy}
        disabled={disabled || busy}
        className="w-full px-3 py-2 rounded-[var(--radius)] bg-accent text-accent-ink hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors duration-[var(--dur-fast)] inline-flex items-center justify-center gap-1.5"
      >
        {busy && (
          <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
        )}
        {status === "loading" && "Starting…"}
        {status === "paying" && "Waiting for payment…"}
        {status === "verifying" && "Verifying…"}
        {(status === "idle" || status === "error") && (disabled ? "Unavailable" : "Buy now")}
      </button>
      {message && status === "error" && <p className="text-xs text-deny-bright">{message}</p>}
    </div>
  );
}
