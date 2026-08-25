"use client";

import { useState } from "react";

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
  sessionToken,
  productName,
  quantity = 1,
  disabled,
  onSuccess,
}: {
  merchantId: string;
  /** Either productId (buy a single product/variant) or offerId (Layer 6-3: buy an accepted upsell's bundle) — mutually exclusive. */
  productId?: string;
  /** Layer 5-7: when the buyer chat resolved a specific variant, pass it so checkout buys exactly what was in the cart rather than the product's default variant. */
  variantId?: string;
  /** Layer 6-3: buy a previously-accepted bundle offer instead of a single product. Requires sessionToken. */
  offerId?: string;
  sessionToken?: string;
  productName: string;
  quantity?: number;
  disabled?: boolean;
  onSuccess?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleBuy() {
    setStatus("loading");
    setMessage(null);

    try {
      await loadCheckoutScript();

      const orderRes = await fetch("/api/checkout/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId, productId, variantId, quantity, offerId, sessionToken }),
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
        theme: { color: "#2563eb" },
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
              headers: { "Content-Type": "application/json" },
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
              onSuccess?.();
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
    return <p className="text-sm text-green-700">{message}</p>;
  }

  return (
    <div className="space-y-1">
      <button
        onClick={handleBuy}
        disabled={disabled || status === "loading" || status === "paying" || status === "verifying"}
        className="w-full px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
      >
        {status === "loading" && "Starting..."}
        {status === "paying" && "Waiting for payment..."}
        {status === "verifying" && "Verifying..."}
        {(status === "idle" || status === "error") && (disabled ? "Unavailable" : "Buy now")}
      </button>
      {message && status === "error" && <p className="text-xs text-red-700">{message}</p>}
    </div>
  );
}
