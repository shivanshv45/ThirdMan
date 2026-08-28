/**
 * The iframe-side half of the embed's postMessage protocol (Layer
 * 10-4). The loader script served from /api/embed/v1.js speaks the same
 * message shape in plain JS — see that route's inline documentation for
 * the host-page side. Keeping both sides on one documented shape here
 * is what stops them drifting apart silently.
 *
 * Message shape, in both directions:
 *   { source: "thirdman-embed", type: string, data?: unknown }
 *
 * iframe -> host event types: cart_updated, order_complete,
 * negotiation_agreed, offer_shown, chat_opened_state (internal, drives
 * the loader's own launcher button state — not part of the public
 * on() event names, which derive chat_opened/chat_closed from it).
 */

export const EMBED_MESSAGE_SOURCE = "thirdman-embed";

export interface EmbedMessage {
  source: typeof EMBED_MESSAGE_SOURCE;
  type: string;
  data?: unknown;
}

/**
 * Posts an event from inside the iframe to the parent (host) page.
 * Silently a no-op outside an iframe (window.parent === window) — the
 * public storefront renders this same component with variant="floating"
 * and never has a parent to notify, so every event emitter in
 * chat-widget.tsx can call this unconditionally without checking
 * "am I embedded" twice.
 *
 * Deliberately does NOT restrict the target origin here: postMessage's
 * targetOrigin is about limiting who receives the message, and the
 * legitimate host origin isn't reliably knowable from inside the iframe
 * (see /embed/[publishableKey]/page.tsx's docstring on why the origin
 * hint in the URL is treated as a hint, not authority). The data sent
 * is already everything the public storefront would show a buyer
 * anyway (see cost-paise-never-leaks.test.ts, extended to cover this),
 * so broadcasting it is not a new disclosure — the authoritative
 * boundary is the ORIGIN CHECK ON THE API CALLS (embed-cors.ts), not
 * this broadcast.
 */
export function postToHost(type: string, data?: unknown): void {
  if (typeof window === "undefined" || window.parent === window) return;
  const message: EmbedMessage = { source: EMBED_MESSAGE_SOURCE, type, data };
  window.parent.postMessage(message, "*");
}

export function isEmbedMessage(value: unknown): value is EmbedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).source === EMBED_MESSAGE_SOURCE &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

/**
 * Fetch headers for a buyer-endpoint call from chat-widget.tsx/
 * buy-button.tsx. The embed key travels as the X-Embed-Key header, not
 * a JSON body field — a real browser CORS preflight (OPTIONS) carries
 * no body, only headers, so the server (embed-cors.ts) can only see the
 * key here. When embedKey is undefined (the public storefront's
 * same-origin floating widget), this is identical to what every route
 * already sent before Layer 10 existed.
 */
export function fetchHeaders(embedKey?: string): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (embedKey) headers["X-Embed-Key"] = embedKey;
  return headers;
}
