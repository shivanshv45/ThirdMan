"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
    script.onerror = () => reject(new Error("Could not load the payment widget."));
    document.body.appendChild(script);
  });
}

/**
 * Triggers a real hold-and-capture demo purchase: creates an order with
 * payment_capture: false via /api/checkout/hold-order, then completes it
 * through the real Razorpay Checkout widget, same mechanism as the
 * public storefront's BuyButton — a genuinely authorized test-mode
 * payment, not a simulated one (see plans/layer-4-front-door.md L4-5).
 */
export function CreateHoldForm({ products }: { products: { id: string; name: string; pricePaise: number }[] }) {
  const router = useRouter();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleCreateHold() {
    if (!productId) return;
    setStatus("working");
    setMessage(null);

    try {
      await loadCheckoutScript();

      const orderRes = await fetch("/api/checkout/hold-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      const order = await orderRes.json();

      if (!orderRes.ok || order.error) {
        setStatus("error");
        setMessage(order.error ?? "Could not start the hold.");
        return;
      }

      const razorpay = new window.Razorpay({
        key: order.razorpayKeyId,
        amount: order.amountPaise,
        currency: "INR",
        name: `${order.productName} (held, not captured)`,
        order_id: order.razorpayOrderId,
        theme: { color: "#4fd1c5" },
        modal: { ondismiss: () => setStatus("idle") },
        handler: async (response) => {
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
              setStatus("idle");
              router.refresh();
            } else {
              setStatus("error");
              setMessage(verify.reason ?? verify.error ?? "Could not confirm the hold.");
            }
          } catch {
            setStatus("error");
            setMessage("Payment was authorised, but confirming it failed to reach the server. It will still be confirmed automatically via webhook.");
          }
        },
      });

      razorpay.open();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (products.length === 0) {
    return <p className="text-sm text-on-ink-dim">Add a product first to demo a hold.</p>;
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-on-ink-dim font-medium">Product</span>
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className="rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={handleCreateHold}
        disabled={status === "working"}
        className="px-3.5 py-2 rounded-[var(--radius)] bg-accent text-accent-ink hover:bg-accent-bright disabled:opacity-50 text-sm font-medium transition-colors duration-[var(--dur-fast)] inline-flex items-center gap-1.5"
      >
        {status === "working" && (
          <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
        )}
        {status === "working" ? "Authorising…" : "Create hold (test payment)"}
      </button>
      {message && <p className="text-xs text-deny-bright w-full">{message}</p>}
    </div>
  );
}
