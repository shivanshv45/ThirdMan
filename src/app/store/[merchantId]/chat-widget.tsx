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

interface CartLine {
  variantId: string;
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  subtotalPaise: number;
}

interface Cart {
  lines: CartLine[];
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
  const [cart, setCart] = useState<Cart>({ lines: [], subtotalPaise: 0 });
  const [offer, setOffer] = useState<Offer | null>(null);
  const [decliningOffer, setDecliningOffer] = useState(false);
  const [negotiation, setNegotiation] = useState<Negotiation | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

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
        className="fixed bottom-6 right-6 px-4 py-3 rounded-full bg-accent text-accent-ink shadow-lg hover:bg-accent-bright text-sm font-medium transition-colors duration-[var(--dur-fast)]"
      >
        Chat with us
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 w-full max-w-sm h-[32rem] bg-ink-raised border border-ink-line rounded-[var(--radius-lg)] shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-line shrink-0">
        <span className="font-medium text-sm text-on-ink flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-allow" aria-hidden="true" />
          Ask about our products
        </span>
        <button onClick={() => setOpen(false)} className="text-on-ink-faint hover:text-on-ink text-sm transition-colors">
          Close
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && (
          <p className="text-sm text-on-ink-faint">Ask what we sell, get a recommendation, or say what you&apos;d like to buy.</p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`text-sm max-w-[85%] rounded-[var(--radius)] px-3 py-2 ${
              m.role === "customer" ? "ml-auto bg-accent text-accent-ink" : "bg-ink-overlay text-on-ink"
            }`}
          >
            {m.content}
          </div>
        ))}
        {/* Real: only shown while the /api/chat round-trip is actually in
            flight (fact 9 — never a decorative "thinking" state). */}
        {sending && (
          <div className="flex items-center gap-1.5 px-3 py-2 text-on-ink-faint" aria-live="polite">
            <span className="h-1.5 w-1.5 rounded-full bg-on-ink-faint animate-bounce [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-on-ink-faint animate-bounce [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-on-ink-faint animate-bounce [animation-delay:240ms]" />
          </div>
        )}
      </div>

      {offer && (
        <div className="border-t border-ink-line px-3 py-2.5 bg-escalate-wash shrink-0">
          <p className="text-sm text-escalate-bright mb-2">{offer.reasonText}</p>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium text-on-ink">{offer.bundleName}</span>
            <span className="font-medium font-mono text-on-ink">{rupees(offer.amountPaise)}</span>
          </div>
          <div className="flex gap-2">
            <BuyButton
              merchantId={merchantId}
              offerId={offer.offerId}
              sessionToken={sessionToken}
              productName={offer.bundleName}
              onSuccess={() => {
                setOffer(null);
                setCart({ lines: [], subtotalPaise: 0 });
              }}
            />
            <button
              onClick={declineOffer}
              disabled={decliningOffer}
              className="px-3 py-2 rounded-[var(--radius)] border border-ink-line text-sm text-on-ink-dim hover:text-on-ink disabled:opacity-50 transition-colors duration-[var(--dur-fast)]"
            >
              No thanks
            </button>
          </div>
        </div>
      )}

      {negotiation && negotiation.status === "agreed" && (
        <div className="border-t border-ink-line px-3 py-2.5 bg-allow-wash shrink-0">
          <p className="text-sm text-allow-bright mb-2">
            Agreed at <span className="font-mono">{rupees(negotiation.agreedUnitPricePaise!)}</span> per unit.
          </p>
          <BuyButton
            merchantId={merchantId}
            negotiationId={negotiation.negotiationId}
            sessionToken={sessionToken}
            productName="Negotiated price"
            onSuccess={() => {
              setNegotiation(null);
              setCart({ lines: [], subtotalPaise: 0 });
            }}
          />
        </div>
      )}

      {negotiation && negotiation.status === "open" && (
        <div className="border-t border-ink-line px-3 py-2.5 bg-escalate-wash shrink-0">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-medium text-escalate-bright">Negotiating</p>
            <p className="text-xs text-escalate-bright font-mono">
              {negotiation.buyerTurnsUsed}/{negotiation.buyerTurnsAllowed} counter-offers
            </p>
          </div>
          <div className="w-full h-1 rounded-full bg-ink-overlay overflow-hidden mb-1.5">
            <div
              className="h-full bg-escalate transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
              style={{ width: `${(negotiation.buyerTurnsUsed / negotiation.buyerTurnsAllowed) * 100}%` }}
            />
          </div>
          <p className="text-xs text-on-ink-dim">
            Propose a price in the message box below (e.g. &ldquo;would you do ₹9 each?&rdquo;).
          </p>
        </div>
      )}

      {cart.lines.length > 0 && !(negotiation && negotiation.status === "agreed") && (
        <div className="border-t border-ink-line px-3 py-2.5 bg-ink-overlay shrink-0">
          <div className="space-y-1 mb-2">
            {cart.lines.map((line) => (
              <div key={line.variantId} className="flex items-center justify-between text-sm">
                <span className="text-on-ink-dim">
                  {line.quantity} × {line.name}
                </span>
                <span className="font-mono text-on-ink-dim">{rupees(line.subtotalPaise)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between text-sm mb-2 pt-1 border-t border-ink-line/50">
            <span className="font-medium text-on-ink">Total</span>
            <span className="font-medium font-mono text-on-ink">{rupees(cart.subtotalPaise)}</span>
          </div>
          <BuyButton
            merchantId={merchantId}
            cart
            sessionToken={sessionToken}
            productName={`Cart (${cart.lines.length} item${cart.lines.length === 1 ? "" : "s"})`}
            onSuccess={() => setCart({ lines: [], subtotalPaise: 0 })}
          />
        </div>
      )}

      <div className="border-t border-ink-line p-2 flex gap-2 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type a message…"
          className="flex-1 rounded-[var(--radius)] bg-ink-overlay border border-ink-line px-3 py-2 text-sm text-on-ink placeholder:text-on-ink-faint outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
          disabled={sending}
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="px-3 py-2 rounded-[var(--radius)] bg-accent text-accent-ink text-sm font-medium hover:bg-accent-bright disabled:opacity-50 transition-colors duration-[var(--dur-fast)]"
        >
          Send
        </button>
      </div>
    </div>
  );
}
