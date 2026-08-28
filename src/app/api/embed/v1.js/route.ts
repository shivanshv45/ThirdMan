import { NextRequest, NextResponse } from "next/server";

/**
 * The one <script> tag a merchant pastes into their own site (Layer
 * 10-2). Served from a route handler rather than public/ so it can set
 * its own cache headers and be regenerated without a build step — see
 * plans/layer-10-embeddable-commerce.md's L10-2 fact 4.
 *
 * Deliberately framework-free, ES5-safe plain JS — no bundler, no JSX,
 * no imports. It does four things: reads its own config off the
 * <script> tag, creates a launcher button plus a hidden <iframe>
 * pointing at /embed/[publishableKey] on THIS origin, wires postMessage
 * both ways (validating event.origin on every inbound message — never
 * trust a message without that check), and exposes window.ThirdMan.
 *
 * Speaks the same message shape src/lib/embed-events.ts documents for
 * the iframe side: { source: "thirdman-embed", type, data }.
 */

const LOADER_SCRIPT = `
(function () {
  "use strict";

  if (window.ThirdMan) return; // already loaded — never double-init.

  var APP_ORIGIN = ${JSON.stringify("")}; // filled in below at request time
  var MESSAGE_SOURCE = "thirdman-embed";
  var STORAGE_KEY_PREFIX = "thirdman-embed-open:";

  // document.currentScript is null for an async/defer-loaded script by
  // the time this IIFE runs in some browsers — fall back to a
  // querySelector on the known data attribute.
  var scriptEl = document.currentScript || document.querySelector("script[data-embed-key]");
  if (!scriptEl) {
    console.error("[ThirdMan embed] could not find its own <script> tag (expected a data-embed-key attribute).");
    return;
  }

  var embedKey = scriptEl.getAttribute("data-embed-key");
  if (!embedKey) {
    console.error("[ThirdMan embed] missing required data-embed-key attribute.");
    return;
  }

  var hostOrigin = window.location.origin;
  var listeners = {};

  function on(type, handler) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
  }

  function off(type, handler) {
    if (!listeners[type]) return;
    listeners[type] = listeners[type].filter(function (h) { return h !== handler; });
  }

  function emit(type, data) {
    var handlers = listeners[type];
    if (!handlers) return;
    // A throwing handler must not break the widget or stop the OTHER
    // handlers from running — each call gets its own try/catch.
    for (var i = 0; i < handlers.length; i++) {
      try {
        handlers[i](data);
      } catch (err) {
        console.error("[ThirdMan embed] a '" + type + "' handler threw:", err);
      }
    }
  }

  // --- DOM: launcher button + hidden iframe ---------------------------

  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.textContent = "Chat with us";
  launcher.setAttribute("aria-label", "Open chat");
  launcher.style.cssText = [
    "position:fixed", "bottom:24px", "right:24px", "z-index:2147483000",
    "padding:12px 20px", "border-radius:999px", "border:none",
    "background:#0d94fb", "color:#fff", "font:500 14px/1 system-ui,-apple-system,sans-serif",
    "cursor:pointer", "box-shadow:0 4px 16px rgba(0,0,0,0.2)",
  ].join(";");

  var iframeWrap = document.createElement("div");
  iframeWrap.style.cssText = [
    "position:fixed", "bottom:24px", "right:24px", "z-index:2147483000",
    "width:min(24rem, calc(100vw - 32px))", "height:32rem", "max-height:calc(100vh - 48px)",
    "border-radius:16px", "overflow:hidden", "box-shadow:0 12px 40px rgba(0,0,0,0.3)",
    "display:none",
  ].join(";");

  var iframe = document.createElement("iframe");
  var iframeSrc = APP_ORIGIN + "/embed/" + encodeURIComponent(embedKey) + "?origin=" + encodeURIComponent(hostOrigin);
  iframe.src = iframeSrc;
  iframe.title = "Chat";
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
  // allow-popups + allow-popups-to-escape-sandbox: Razorpay Checkout
  // opens popups/redirects for UPI/netbanking/3DS — without both, the
  // buyer clicks Pay and nothing visibly happens. allow-same-origin is
  // needed for the iframe's own sessionStorage (the buyer chat's
  // session token). See plans/layer-10-embeddable-commerce.md fact 3 —
  // verified against a real test payment, not inferred.
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation");
  iframe.setAttribute("allow", "payment");
  iframeWrap.appendChild(iframe);

  function ready() {
    if (document.body) {
      document.body.appendChild(launcher);
      document.body.appendChild(iframeWrap);
    } else {
      document.addEventListener("DOMContentLoaded", ready);
    }
  }
  ready();

  function setOpen(open) {
    iframeWrap.style.display = open ? "block" : "none";
    launcher.style.display = open ? "none" : "block";
    try {
      sessionStorage.setItem(STORAGE_KEY_PREFIX + embedKey, open ? "1" : "0");
    } catch (e) {
      // sessionStorage unavailable (private browsing) — state just
      // won't survive a reload, the widget still functions.
    }
    emit(open ? "chat_opened" : "chat_closed", undefined);
  }

  launcher.addEventListener("click", function () { setOpen(true); });

  // --- postMessage wiring ---------------------------------------------

  window.addEventListener("message", function (event) {
    // Never trust a message without checking its origin first — any
    // page could postMessage into this window. Only the iframe we
    // ourselves created, on this app's own origin, is a legitimate
    // sender.
    if (event.origin !== APP_ORIGIN) return;
    if (event.source !== iframe.contentWindow) return;

    var msg = event.data;
    if (!msg || msg.source !== MESSAGE_SOURCE || typeof msg.type !== "string") return;

    if (msg.type === "close_request") {
      setOpen(false);
      return;
    }
    if (msg.type === "resize") {
      var h = msg.data && msg.data.height;
      if (typeof h === "number" && h > 0) {
        // Clamp so a long conversation can't grow the frame taller
        // than the viewport.
        var clamped = Math.min(h, window.innerHeight - 48);
        iframeWrap.style.height = clamped + "px";
      }
      return;
    }
    if (msg.type === "chat_opened_state") {
      // Internal only — the iframe reports its own open/closed React
      // state on mount; doesn't drive the host's launcher visibility
      // (the host launcher already owns that), just avoids the two
      // getting out of sync if something else set it.
      return;
    }

    // Every remaining type is a public event forwarded verbatim to any
    // handler registered via ThirdMan.on(). Real data, from a real
    // server response the iframe already received — never synthesised
    // here.
    emit(msg.type, msg.data);
  });

  // --- public API --------------------------------------------------------

  window.ThirdMan = {
    on: on,
    off: off,
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
  };
})();
`;

export async function GET(req: NextRequest) {
  const appOrigin = req.nextUrl.origin;
  const script = LOADER_SCRIPT.replace('var APP_ORIGIN = "";', `var APP_ORIGIN = ${JSON.stringify(appOrigin)};`);

  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Short max-age so a real fix is reachable, not immutable —
      // a merchant's snippet references this exact path forever.
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
