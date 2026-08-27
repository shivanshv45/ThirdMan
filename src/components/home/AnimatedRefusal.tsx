"use client";

import { motion } from "framer-motion";
import { ShieldAlert } from "lucide-react";

export function AnimatedRefusal() {
  return (
    <section className="border-t border-ink-line bg-ink-raised relative overflow-hidden">
      {/* Decorative gradient orb */}
      <div className="absolute top-0 right-[20%] w-96 h-96 bg-deny-wash rounded-full blur-[120px] opacity-30 pointer-events-none" />

      <div className="max-w-[var(--shell)] mx-auto px-6 md:px-10 py-[calc(var(--section-y)*1.25)] relative">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="grid lg:grid-cols-[1fr_1.2fr] gap-16 lg:gap-24 items-center"
        >
          <div className="max-w-xl">
            <div className="inline-flex items-center gap-2 mb-6">
              <ShieldAlert className="w-5 h-5 text-deny-bright" />
              <p className="text-xs uppercase tracking-[0.15em] text-on-ink-faint font-medium">
                Every refusal is evidence
              </p>
            </div>
            <h2 className="font-[family-name:var(--font-display)] text-[var(--t-h1)] font-medium text-on-ink tracking-tight leading-[1.1]">
              Most commerce tools show you what happened.{" "}
              <span className="text-on-ink-dim block mt-2">This one shows you what it refused to do.</span>
            </h2>
            <p className="text-sm text-on-ink-faint mt-8 max-w-md leading-relaxed border-l-2 border-ink-line pl-4">
              An agent asserting its own price for a real product is denied before any money moves — not by a model deciding it looks suspicious, but by code re-deriving the number and refusing on mismatch.
            </p>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95, rotateX: 10 }}
            whileInView={{ opacity: 1, scale: 1, rotateX: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8, delay: 0.2, type: "spring", damping: 20 }}
            className="rounded-[var(--radius-lg)] border border-deny-line/50 bg-ink overflow-hidden shadow-2xl relative"
            style={{ perspective: 1000 }}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-deny-wash/20 to-transparent pointer-events-none" />
            
            <div className="px-5 py-4 border-b border-ink-line flex flex-wrap items-center justify-between gap-y-2 gap-x-3 bg-ink-raised/50 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-ink-line" />
                  <div className="w-2.5 h-2.5 rounded-full bg-ink-line" />
                  <div className="w-2.5 h-2.5 rounded-full bg-ink-line" />
                </div>
                <span className="ml-3 text-[10px] font-mono text-on-ink-faint tracking-wider uppercase">Audit Log · Incident</span>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium bg-deny-wash text-deny-bright border border-deny-line shadow-[0_0_10px_rgba(255,107,107,0.15)]">
                <span className="h-1.5 w-1.5 rounded-full bg-deny-bright animate-pulse" aria-hidden="true" />
                Action Denied
              </span>
            </div>
            
            <div className="px-6 py-8 relative">
              <div className="font-mono text-sm leading-relaxed text-on-ink-dim">
                <span className="text-deny-bright font-medium">Denied</span> — caller asserted{" "}
                <span className="text-on-ink px-1.5 py-0.5 bg-ink-raised rounded">₹1,499.00</span> for{" "}
                <span className="text-accent-bright">"espresso-blend-250g" x3</span>, but the catalogue price is{" "}
                <span className="text-on-ink px-1.5 py-0.5 bg-ink-raised rounded">₹1,299.00</span>.
                <br /><br />
                <span className="opacity-70">Price comes from the catalogue, never the caller.</span>
              </div>
              
              <div className="flex flex-wrap gap-x-6 gap-y-2 mt-8 text-xs text-on-ink-faint font-mono border-t border-ink-line/50 pt-4">
                <span className="flex items-center gap-1.5">
                  <span className="text-on-ink-dim">bound:</span> product_price_match
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-on-ink-dim">determinism:</span> arithmetic, no model
                </span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
