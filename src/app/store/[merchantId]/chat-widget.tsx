"use client";

import { useEffect, useRef, useState } from "react";
import { formatPaise as rupees } from "@/lib/money";
import { BuyButton } from "./buy-button";

/**
 * The human front door's conversational surface (Layer 4-6). The model
 * (src/lib/chat.ts) does discovery and conversation; this component only
 * renders what the server already computed — it never calculates a
 * price or decides whether a purchase is allowed itself. Checkout for
 * the cart reuses the same real BuyButton/Razorpay Checkout flow as the
 * product grid.
 */

const SESSION_STORAGE_KEY = "chat-session-token";

function getOrCreateSessionToken(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // sessionStorage unavailable (private browsing, blocked) — a
    // per-render token still lets the chat function, just without
    // surviving a reload.
    return crypto.randomUUID();
  }
}

interface Message {
  role: "customer" | "assistant";
  content: string;
}

interface Cart {
  // "id" is the resolved variant's own id (Layer 5-7 — chat.ts's
  // ChatProduct is variant-level); "productId" is the parent product,
  // which BuyButton's checkout call needs alongside it.
  product: { id: string; productId: string; name: string; pricePaise: number };
  quantity: number;
  subtotalPaise: number;
}

interface Offer {
  offerId: string;
  bundleName: string;
  amountPaise: number;
  reasonText: string;
}

interface Negotiation {
  negotiationId: string;
  status: string;
  catalogueUnitPricePaise: number;
  agreedUnitPricePaise: number | null;
  buyerTurnsUsed: number;
  buyerTurnsAllowed: number;
}

export function ChatWidget({ merchantId }: { merchantId: string }) {
  const [open, setOpen] = useState(false);
  // Lazy initializer runs once on mount, client-side only (this is a
  // client component) — safe to touch sessionStorage/crypto here without
  // the effect-based setState React's own lint rule warns against.
  const [sessionToken] = useState<string>(() => getOrCreateSessionToken());
  const [messages, setMessages] = useState<Message[]>([]);
  const [cart, setCart] = useState<Cart | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [decliningOffer, setDecliningOffer] = useState(false);
  const [negotiation, setNegotiation] = useState<Negotiation | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const message = input.trim();
    if (!message || !sessionToken || sending) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "customer", content: message }]);
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId, sessionToken, message }),
      });
      const data = await res.json();

      if (res.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
        setCart(data.cart);
        setOffer(data.offer ?? null);
        setNegotiation(data.negotiation ?? null);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: "Sorry, something went wrong. Please try again." }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Sorry, I couldn't reach the server. Please try again." }]);
    } finally {
      setSending(false);
    }
  }

  async function declineOffer() {
    if (!offer || decliningOffer) return;
    setDecliningOffer(true);
    try {
      await fetch("/api/checkout/decline-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId, offerId: offer.offerId, sessionToken }),
      });
    } finally {
      setOffer(null);
      setDecliningOffer(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 px-4 py-3 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 text-sm font-medium"
      >
        Chat with us
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 w-full max-w-sm h-[32rem] bg-white border rounded-lg shadow-xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="font-medium text-sm">Ask about our products</span>
        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 text-sm">
          Close
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400">Ask what we sell, get a recommendation, or say what you&apos;d like to buy.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`text-sm max-w-[85%] rounded-lg px-3 py-2 ${m.role === "customer" ? "ml-auto bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}>
            {m.content}
          </div>
        ))}
        {sending && <div className="text-sm text-gray-400">Thinking…</div>}
      </div>

      {offer && (
        <div className="border-t px-3 py-2 bg-amber-50">
          <p className="text-sm text-amber-900 mb-2">{offer.reasonText}</p>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium">{offer.bundleName}</span>
            <span className="font-medium">{rupees(offer.amountPaise)}</span>
          </div>
          <div className="flex gap-2">
            <BuyButton
              merchantId={merchantId}
              offerId={offer.offerId}
              sessionToken={sessionToken}
              productName={offer.bundleName}
              onSuccess={() => {
                setOffer(null);
                setCart(null);
              }}
            />
            <button
              onClick={declineOffer}
              disabled={decliningOffer}
              className="px-3 py-2 rounded border text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
            >
              No thanks
            </button>
          </div>
        </div>
      )}

      {negotiation && negotiation.status === "agreed" && cart && (
        <div className="border-t px-3 py-2 bg-green-50">
          <p className="text-sm text-green-900 mb-2">
            Agreed at {rupees(negotiation.agreedUnitPricePaise!)} per unit.
          </p>
          <BuyButton
            merchantId={merchantId}
            negotiationId={negotiation.negotiationId}
            sessionToken={sessionToken}
            productName={cart.product.name}
            onSuccess={() => {
              setNegotiation(null);
              setCart(null);
            }}
          />
        </div>
      )}

      {negotiation && negotiation.status === "open" && (
        <div className="border-t px-3 py-2 bg-amber-50">
          <p className="text-xs text-amber-900">
            Negotiating — {negotiation.buyerTurnsUsed}/{negotiation.buyerTurnsAllowed} counter-offers used. Propose a price in the message box below (e.g. &ldquo;would you do ₹9 each?&rdquo;).
          </p>
        </div>
      )}

      {cart && !(negotiation && negotiation.status === "agreed") && (
        <div className="border-t px-3 py-2 bg-gray-50">
          <div className="flex items-center justify-between text-sm mb-2">
            <span>
              {cart.quantity} x {cart.product.name}
            </span>
            <span className="font-medium">{rupees(cart.subtotalPaise)}</span>
          </div>
          <BuyButton
            merchantId={merchantId}
            productId={cart.product.productId}
            variantId={cart.product.id}
            productName={cart.product.name}
            quantity={cart.quantity}
            onSuccess={() => setCart(null)}
          />
        </div>
      )}

      <div className="border-t p-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type a message…"
          className="flex-1 border rounded px-3 py-2 text-sm"
          disabled={sending}
        />
        <button onClick={send} disabled={sending || !input.trim()} className="px-3 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50">
          Send
        </button>
      </div>
    </div>
  );
}
