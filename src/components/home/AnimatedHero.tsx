"use client";

import { motion, Variants } from "framer-motion";
import Link from "next/link";
import { AmbientField, DecisionBadge } from "@/components/ui";

const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1,
    },
  },
};

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 50, damping: 20 } },
};

export function AnimatedHero() {
  return (
    <section className="relative isolate overflow-hidden min-h-[92svh] flex flex-col justify-start pt-[clamp(8rem,22vh,12rem)] pb-16">
      <div className="absolute inset-0 -z-10 bg-ink">
        <AmbientField />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(10,13,15,0.2) 0%, rgba(10,13,15,0.7) 50%, rgba(10,13,15,0.98) 100%)",
          }}
        />
      </div>

      <div className="max-w-[var(--shell)] mx-auto px-6 md:px-10 w-full flex-1 flex flex-col">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="grid lg:grid-cols-[1.3fr_0.7fr] gap-12 items-center flex-1"
        >
          <div className="flex flex-col items-start text-left">
            <motion.div variants={fadeUp} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-ink-raised border border-ink-line mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-bright animate-pulse" />
              <span className="text-[11px] uppercase tracking-[0.2em] text-on-ink-faint font-medium">For Razorpay Merchants</span>
            </motion.div>
            
            <motion.h1 
              variants={fadeUp} 
              className="font-[family-name:var(--font-display)] text-[clamp(2.5rem,5.5vw,4.5rem)] font-medium tracking-tight text-on-ink leading-[1.05]"
            >
              Let AI agents buy from your store — <span className="text-on-ink-dim block mt-2">without letting them overspend.</span>
            </motion.h1>
            
            <motion.p variants={fadeUp} className="text-[var(--t-lead)] text-on-ink-dim mt-8 max-w-lg leading-relaxed">
              Connect your Razorpay account, set a spend cap per agent, and every purchase is checked before a single rupee moves. Bounded, audited, and deterministic.
            </motion.p>

            <motion.div variants={fadeUp} className="flex flex-wrap gap-4 mt-10">
              <Link
                href="/signup"
                className="group relative px-6 py-3.5 rounded-[var(--radius)] bg-accent text-accent-ink font-medium overflow-hidden shadow-[0_0_20px_rgba(79,209,197,0.15)] hover:shadow-[0_0_30px_rgba(79,209,197,0.3)] transition-all duration-300"
              >
                <span className="relative z-10">Sign up free</span>
                <div className="absolute inset-0 bg-accent-bright scale-x-0 origin-left group-hover:scale-x-100 transition-transform duration-300 ease-out" />
              </Link>
              <Link
                href="/login"
                className="px-6 py-3.5 rounded-[var(--radius)] border border-ink-line text-on-ink font-medium hover:border-on-ink-faint hover:bg-ink-raised transition-colors duration-[var(--dur-fast)]"
              >
                Log in
              </Link>
            </motion.div>
          </div>

          <motion.div 
            variants={fadeUp} 
            className="hidden lg:flex relative h-full w-full flex-col justify-center items-end"
          >
            <div className="relative w-full max-w-sm flex flex-col items-end gap-3 pointer-events-none pr-8">
              <motion.div 
                initial={{ opacity: 0, x: 30, rotate: 2 }} 
                animate={{ opacity: 1, x: 0, rotate: 0 }} 
                transition={{ delay: 0.6, type: "spring", stiffness: 60 }}
                className="origin-right scale-110"
              >
                <DecisionBadge decision="allow" />
              </motion.div>
              <motion.div 
                initial={{ opacity: 0, x: -20, rotate: -2 }} 
                animate={{ opacity: 1, x: -16, rotate: -4 }} 
                transition={{ delay: 0.8, type: "spring", stiffness: 60 }}
                className="origin-right scale-[1.3] z-10 drop-shadow-2xl"
              >
                <DecisionBadge decision="escalate" />
              </motion.div>
              <motion.div 
                initial={{ opacity: 0, x: 30, rotate: 3 }} 
                animate={{ opacity: 1, x: 8, rotate: 2 }} 
                transition={{ delay: 1.0, type: "spring", stiffness: 60 }}
                className="origin-right scale-110"
              >
                <DecisionBadge decision="deny" />
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
